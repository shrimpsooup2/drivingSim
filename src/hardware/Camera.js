/**
 * A webcam on the robot, and the AprilTags it can see.
 *
 * ## What is actually modelled
 *
 * The four things that decide whether tag localisation works on a real robot,
 * all of which a naive simulator gets wrong by giving you a perfect pose:
 *
 *  - **Whether you can see it at all.** Field of view, range, and -- the one
 *    everybody forgets -- *incidence*. A tag seen at 80 degrees off its normal
 *    is a few pixels wide and does not decode. In BIOBUZZ the clusters face
 *    downward off the underside of a CELL, so this is the binding constraint:
 *    see `field/biobuzz/aprilTags.js`.
 *  - **How big it is on the sensor.** Derived from the resolution and the field
 *    of view rather than assumed, so a 3.25 in tag at 4 m really is about six
 *    pixels across and really does not decode.
 *  - **Frame rate.** 30 Hz, so a detection is up to 33 ms stale before the
 *    pipeline even starts.
 *  - **Latency.** Exposure, transfer, decode, and the processor thread: about
 *    60 ms all told. At 1 m/s that is 6 cm of position error with a *perfect*
 *    tag reading, and it is why a pose fix has to be applied thoughtfully
 *    rather than every loop.
 *
 * Ported from the JVM simulator's `VisionPortalImpl` / `AprilTagProcessorImpl`,
 * which run a 30 Hz loop computing detections from the true pose, the field and
 * the camera mount. Same idea, same absence of actual camera frames -- there is
 * no image here and nothing is decoded, because what a team needs to practise
 * against is the geometry and the timing.
 *
 * ## What it hands back
 *
 * Measurements, not a pose: `range`, `bearing` and `elevation`, which is what
 * `AprilTagDetection.ftcPose` gives you and what most FTC code uses. A pose
 * follows from a measurement plus the tag's known place on the FIELD plus your
 * own heading -- `poseFrom` does that arithmetic -- so the error in the pose is
 * the error in the measurement plus the error in your heading, both of which
 * are modelled elsewhere and neither of which is invented here.
 *
 * ## It costs no loop time
 *
 * Deliberately: vision runs on its own thread, and reading the latest
 * detections is a Java call rather than a hub transaction. So `robot.camera`
 * charges nothing to the `HardwareBus` -- which is real, and is also why the
 * data is old. Free and stale, rather than expensive and fresh.
 *
 * @module
 */
import { wrapAngle } from '../math/MathUtil.js';

/** @typedef {import('../field/biobuzz/aprilTags.js').TagPose} TagPose */

/**
 * @typedef {object} TagDetection
 * @property {number} id
 * @property {number} range      metres, camera to tag centre
 * @property {number} bearing    radians, positive to the camera's left
 * @property {number} elevation  radians, positive above the camera's axis
 * @property {number} incidence  radians off the tag's normal; 0 is face on
 * @property {number} pixels     apparent width on the sensor
 * @property {number} age        seconds since the frame was taken
 * @property {TagPose} tag       where the tag was when the frame was taken
 */

export class Camera {
  /**
   * @param {{
   *   enabled?: boolean,
   *   x?: number, y?: number, z?: number,
   *   yaw?: number, pitch?: number,
   *   fovDegrees?: number,
   *   widthPixels?: number, heightPixels?: number,
   *   rangeMin?: number, rangeMax?: number,
   *   maxIncidenceDegrees?: number,
   *   minTagPixels?: number,
   *   frameRateHz?: number,
   *   latencySeconds?: number,
   *   rangeNoise?: number, bearingNoiseDegrees?: number,
   *   random?: () => number,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.applySettings(opts);
    this.random = opts.random ?? Math.random;
    this.reset();
  }

  /** @param {object} cfg */
  applySettings(cfg = {}) {
    this.enabled = cfg.enabled ?? this.enabled ?? true;
    /** Mount in the robot frame: +x forward, +y left, z above the tiles. */
    this.x = cfg.x ?? this.x ?? 0.15;
    this.y = cfg.y ?? this.y ?? 0;
    this.z = cfg.z ?? this.z ?? 0.25;
    /**
     * Radians. Yaw 0 looks straight ahead; pitch is positive upward.
     *
     * Taken from `yawDegrees` / `pitchDegrees` when those are given, because
     * that is how the settings panel and a team's own notes express a camera
     * mount, and radians in a config file are a conversion waiting to be got
     * wrong.
     */
    this.yaw = degreesOr(cfg.yawDegrees, cfg.yaw, this.yaw, 0);
    this.pitch = degreesOr(cfg.pitchDegrees, cfg.pitch, this.pitch, 0);
    /** Horizontal field of view. A C270 is about 60 degrees. */
    this.fovDegrees = cfg.fovDegrees ?? this.fovDegrees ?? 60;
    this.widthPixels = cfg.widthPixels ?? this.widthPixels ?? 640;
    this.heightPixels = cfg.heightPixels ?? this.heightPixels ?? 480;
    this.rangeMin = cfg.rangeMin ?? this.rangeMin ?? 0.15;
    this.rangeMax = cfg.rangeMax ?? this.rangeMax ?? 5;
    /** Past this far off the tag's normal it will not decode. */
    this.maxIncidenceDegrees = cfg.maxIncidenceDegrees ?? this.maxIncidenceDegrees ?? 70;
    /** How many pixels wide a tag has to be. Below about 12 it is noise. */
    this.minTagPixels = cfg.minTagPixels ?? this.minTagPixels ?? 14;
    this.frameRateHz = cfg.frameRateHz ?? this.frameRateHz ?? 30;
    this.latencySeconds =
      cfg.latencyMs !== undefined
        ? cfg.latencyMs / 1000
        : cfg.latencySeconds ?? this.latencySeconds ?? 0.06;
    /** Range error as a fraction of range: a couple of percent is realistic. */
    this.rangeNoise = cfg.rangeNoise ?? this.rangeNoise ?? 0.02;
    this.bearingNoiseDegrees = cfg.bearingNoiseDegrees ?? this.bearingNoiseDegrees ?? 0.5;
    return this;
  }

  reset() {
    /** @type {TagDetection[]} */
    this.detections = [];
    /** Frames taken but not yet published, oldest first. */
    this._pipeline = [];
    this.time = 0;
    this._nextFrameAt = 0;
    /** Frames taken and frames published, for the inspector. */
    this.frames = 0;
    this.published = 0;
    return this;
  }

  /** Horizontal and vertical field of view, radians. */
  get fov() {
    const h = (this.fovDegrees * Math.PI) / 180;
    // From the sensor's aspect, not assumed: a 4:3 camera with 60 degrees
    // across has 46 up and down, and the vertical one is what decides whether
    // a tag on the underside of a raised CELL is in frame.
    const v = 2 * Math.atan((Math.tan(h / 2) * this.heightPixels) / this.widthPixels);
    return { h, v };
  }

  /** Where the lens is and which way it points, given the robot's pose. */
  poseIn(robotPose) {
    const c = Math.cos(robotPose.heading);
    const s = Math.sin(robotPose.heading);
    const yaw = robotPose.heading + this.yaw;
    const cp = Math.cos(this.pitch);
    return {
      x: robotPose.x + c * this.x - s * this.y,
      y: robotPose.y + s * this.x + c * this.y,
      z: this.z,
      forward: { x: cp * Math.cos(yaw), y: cp * Math.sin(yaw), z: Math.sin(this.pitch) },
      right: { x: Math.sin(yaw), y: -Math.cos(yaw), z: 0 },
      yaw,
    };
  }

  /**
   * Run the pipeline forward.
   *
   * @param {number} dt seconds
   * @param {{x: number, y: number, heading: number}} robotPose the true pose
   * @param {TagPose[]} tags every tag on the FIELD, where it is now
   */
  update(dt, robotPose, tags) {
    if (!this.enabled) {
      if (this.detections.length) this.detections = [];
      return this.detections;
    }
    this.time += dt;

    // Expose a frame when the shutter comes round.
    if (this.time >= this._nextFrameAt) {
      const period = 1 / Math.max(1, this.frameRateHz);
      this._nextFrameAt = this.time + period;
      this._pipeline.push({ at: this.time, found: this._look(robotPose, tags ?? []) });
      this.frames++;
    }

    // And publish the newest frame that has finished being processed. Newest,
    // not oldest: a real pipeline drops frames it has fallen behind on rather
    // than handing you a queue of history.
    let ready = -1;
    for (let i = 0; i < this._pipeline.length; i++) {
      if (this.time - this._pipeline[i].at >= this.latencySeconds) ready = i;
    }
    if (ready >= 0) {
      const frame = this._pipeline[ready];
      const age = this.time - frame.at;
      this.detections = frame.found.map((d) => ({ ...d, age }));
      this._pipeline.splice(0, ready + 1);
      this.published++;
    }
    return this.detections;
  }

  /**
   * What is in frame, right now, with no latency applied.
   * @param {{x: number, y: number, heading: number}} robotPose
   * @param {TagPose[]} tags
   */
  _look(robotPose, tags) {
    const cam = this.poseIn(robotPose);
    const up = cross(cam.right, cam.forward);
    const fov = this.fov;
    const pxPerRad = this.widthPixels / fov.h;
    const maxIncidence = (this.maxIncidenceDegrees * Math.PI) / 180;
    const out = [];

    for (const tag of tags) {
      const d = { x: tag.x - cam.x, y: tag.y - cam.y, z: tag.z - cam.z };
      const range = Math.hypot(d.x, d.y, d.z);
      if (range < this.rangeMin || range > this.rangeMax) continue;

      const along = dot(d, cam.forward);
      if (along <= 0) continue;
      const across = dot(d, cam.right);
      const vertical = dot(d, up);

      // Positive to the left, as the SDK reports it: the angle you would turn
      // counter-clockwise to face the tag.
      const bearing = -Math.atan2(across, along);
      const elevation = Math.atan2(vertical, Math.hypot(along, across));
      if (Math.abs(bearing) > fov.h / 2 || Math.abs(elevation) > fov.v / 2) continue;

      // The printed face has to be pointing back at us.
      const toCamera = { x: -d.x / range, y: -d.y / range, z: -d.z / range };
      const facing = dot(tag.normal, toCamera);
      if (facing <= 0) continue;
      const incidence = Math.acos(Math.min(1, facing));
      if (incidence > maxIncidence) continue;

      // Foreshortened width on the sensor. This is the test that fails, and it
      // fails for the right reason: distance and angle together.
      const pixels = ((tag.size * facing) / range) * pxPerRad;
      if (pixels < this.minTagPixels) continue;

      out.push({
        id: tag.id,
        range: range * (1 + this._noise() * this.rangeNoise),
        bearing: bearing + this._noise() * ((this.bearingNoiseDegrees * Math.PI) / 180),
        elevation: elevation + this._noise() * ((this.bearingNoiseDegrees * Math.PI) / 180),
        incidence,
        pixels,
        age: 0,
        tag,
      });
    }
    // Biggest first: the closest, squarest tag is the one to trust.
    out.sort((a, b) => b.pixels - a.pixels);
    return out;
  }

  /**
   * The robot pose a detection implies, given a heading you already trust.
   *
   * This is the arithmetic every tag-localising FTC op-mode does. The tag's
   * place on the FIELD is known; the detection gives the range and the bearing
   * from the camera; your heading says which way the camera was pointing. Put
   * the three together and you have where the camera was, and from the mount,
   * where the robot was.
   *
   * A heading is needed because these detections are measurements rather than a
   * solved 6-DoF pose. Feed it the IMU or the odometry's heading: the error in
   * the result is then honestly the measurement error plus your heading error,
   * and both of those are modelled rather than assumed away.
   *
   * @param {TagDetection} detection
   * @param {number} heading radians, the robot's heading when the frame was taken
   * @returns {{x: number, y: number, heading: number, range: number, age: number}}
   */
  poseFrom(detection, heading) {
    // Rebuild the direction to the tag in the camera's own frame, then put it
    // back into the world through the camera's basis. Not by flattening the
    // bearing into a compass heading: `bearing` and `elevation` are measured in
    // the *camera's* frame, so on a camera that is pitched up they are not the
    // horizontal and vertical angles a compass reconstruction assumes, and the
    // error that causes is systematic and grows with range.
    const cam = this.poseIn({ x: 0, y: 0, heading });
    const up = cross(cam.right, cam.forward);
    const flat = detection.range * Math.cos(detection.elevation);
    const along = flat * Math.cos(detection.bearing);
    const across = -flat * Math.sin(detection.bearing);
    const vertical = detection.range * Math.sin(detection.elevation);

    const dx = cam.forward.x * along + cam.right.x * across + up.x * vertical;
    const dy = cam.forward.y * along + cam.right.y * across + up.y * vertical;

    // `cam` was built at the origin, so its x and y are the mount offset
    // already rotated into the field -- exactly what has to come back off.
    return {
      x: detection.tag.x - dx - cam.x,
      y: detection.tag.y - dy - cam.y,
      heading: wrapAngle(heading),
      range: detection.range,
      age: detection.age,
    };
  }

  /**
   * The best pose fix available, or null.
   *
   * The biggest tag in frame rather than an average of all of them: averaging
   * four tags on one cluster four inches apart buys almost nothing, and
   * averaging across clusters mixes a good reading with a glancing one.
   * @param {number} heading radians
   */
  bestPose(heading) {
    const best = this.detections[0];
    return best ? this.poseFrom(best, heading) : null;
  }

  /** Uniform in -1..1. Uniform rather than Gaussian: it is a bound, not a tail. */
  _noise() {
    return this.random() * 2 - 1;
  }

  /** For the inspector. */
  status() {
    return {
      enabled: this.enabled,
      detections: this.detections.length,
      ids: this.detections.map((d) => d.id),
      frames: this.frames,
      published: this.published,
      ageMs: (this.detections[0]?.age ?? 0) * 1000,
    };
  }
}

/** Prefer a value in degrees, then one in radians, then what we had. */
function degreesOr(degrees, radians, current, fallback) {
  if (degrees !== undefined && Number.isFinite(degrees)) return (degrees * Math.PI) / 180;
  if (radians !== undefined && Number.isFinite(radians)) return radians;
  return current ?? fallback;
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
