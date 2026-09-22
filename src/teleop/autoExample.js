/**
 * The AUTO routine the editor starts with.
 *
 * A template that actually scores, because the useful thing to hand somebody
 * is not an empty box: it is a routine that shoots its pre-load, leaves the
 * wall and parks, written the way a real one is -- closed-loop on the IMU for
 * heading, closed-loop on the encoders for distance, waiting on the flywheel
 * rather than guessing at a duration.
 *
 * Deliberately not clever. Everything in it is something a team would write
 * and then change: the headings, the distances, how many shots, whether to
 * park at all.
 *
 * @module
 */
export const EXAMPLE_AUTO = `// BIOBUZZ auto. Runs during the 30-second AUTO period, on the real physics:
// real battery sag, real encoder quantisation, real flywheel recovery.
//
//   yield 1.2                 wait 1.2 seconds
//   yield () => condition     wait until it is true
//   yield                     wait one op-mode cycle (20 ms)
//   yield* helper(robot)      run another generator to completion
//
// robot.draw.* marks the tiles, so you can see what the routine thinks.
//
// Closed-loop on the IMU and the encoders, which is how a real auto goes.
// robot.truth is the exact pose -- useful for working out what went wrong, but
// steer by it and this will not survive the trip to a real field.

const WRAP = (deg) => ((deg + 540) % 360) - 180;

// resetYaw() makes the IMU read zero wherever the robot happens to be sitting,
// so it measures how far you have turned *since the start*, not where you are
// pointing on the field. Every field heading below is therefore start + yaw,
// and START is the heading of the tile you are placed on -- which your team
// decides before the match and writes down, exactly like this.
let START = 0;

function init(robot) {
  robot.imu.reset();
  START = robot.match.alliance === 'red' ? 0 : 180;
  robot.log('auto on ' + robot.match.alliance + ', ' + robot.held + ' pre-loaded');
}

// Show your working. robot.draw puts marks on the tiles, which is how you see
// what the routine *believed* rather than only what the robot did. Called from
// loop(), which runs every cycle alongside the generator below.
function loop(robot) {
  robot.draw.clear();
  robot.draw.point(robot.cellTarget, 'amber');
  if (robot.odometry.fitted) robot.draw.pose(robot.odometry.pose, 'cyan');
  if (aiming) robot.draw.line(robot.truth, robot.cellTarget, 'green');
}

let aiming = false;

// Where the robot is pointing on the field, in degrees.
//
// One IMU read, kept in a variable. Each read is an I2C transaction and costs
// about 2.5 ms of loop time, so reading it three times in one cycle really does
// make the routine run slower -- watch robot.hub.loopMs.
const facing = (robot) => WRAP(START + robot.imu.heading);

// Turn onto an absolute field heading, closing the loop on the IMU.
function* turnTo(robot, degrees) {
  for (let cycle = 0; cycle < 300; cycle++) {
    const error = WRAP(degrees - facing(robot));
    if (Math.abs(error) < 2) break;
    robot.drive(0, 0, Math.max(-0.45, Math.min(0.45, error / 45)));
    yield;
  }
  robot.drive(0, 0, 0);
  yield 0.15;
}

// Drive a distance on the encoders.
//
// SLIP is the number every real auto is tuned around: the encoders measure
// *wheel* travel, and the chassis always moves less -- the wheels scrub on
// acceleration, and a mecanum's rollers scrub all the time. Measure it on a
// practice field by driving a metre and looking at where the robot stopped.
const SLIP = 0.88;

function* driveMetres(robot, metres, power = 0.5) {
  robot.resetEncoders();
  robot.drive(metres < 0 ? -Math.abs(power) : Math.abs(power), 0, 0);
  yield () => robot.travelled >= Math.abs(metres) / SLIP;
  robot.drive(0, 0, 0);
  yield 0.2;
}

// Turn onto a point and drive to it, closing the loop on the distance left
// rather than trusting one measured number. Slower than open-loop timing and
// far harder to break.
function* driveTo(robot, point, tolerance = 0.18, power = 0.55) {
  yield* turnTo(robot, robot.bearingTo(point));
  robot.drive(power, 0, 0);
  const deadline = robot.time + 6;
  yield () => robot.distanceTo(point) < tolerance || robot.time > deadline;
  robot.drive(0, 0, 0);
  yield 0.2;
}

function* auto(robot) {
  // The start pose is against the wall and *behind* the CELL's opening plane.
  // The opening is tilted and faces one way, so from here there is no arc at
  // any speed or angle -- the first job is getting somewhere a shot exists.
  // Straight ahead only: the HIVE's A-frame foot is 0.6 m off centre.
  //
  // Closed loop on the thing that actually matters. aimAtCell() is false until
  // a shot exists and true once one does, which beats driving a distance
  // somebody measured once.
  robot.drive(0.5, 0, 0);
  const stopBy = robot.time + 4;
  yield () => robot.shooter.aimAtCell() || robot.time > stopBy;
  robot.drive(0, 0, 0);
  yield 0.2;

  if (!robot.shooter.aimAtCell()) {
    // Nowhere straight ahead. Down the field and try again: the opening faces
    // one end of the arm, so one side of the FIELD works and the other does
    // not.
    yield* turnTo(robot, robot.match.alliance === 'red' ? -90 : 90);
    robot.drive(0.5, 0, 0);
    const retryBy = robot.time + 4;
    yield () => robot.shooter.aimAtCell() || robot.time > retryBy;
    robot.drive(0, 0, 0);
    yield 0.2;
  }

  // Onto the CELL and empty the magazine.
  robot.shooter.spinUp();
  aiming = true;
  for (let shot = 0; shot < 4; shot++) {
    yield* turnTo(robot, robot.bearingTo(robot.cellTarget));
    if (!robot.shooter.aimAtCell()) {
      robot.log('no shot from ' + robot.truth.x.toFixed(2) + ',' + robot.truth.y.toFixed(2));
      break;
    }
    // Wait for the wheel every time. Firing early throws short; firing over
    // the commanded speed throws long, and a flywheel has no brake.
    yield () => robot.shooter.ready;
    robot.shooter.fire();
    robot.telemetry.addData('shots', robot.shooter.shots);
    yield 0.45;
  }
  robot.shooter.spinDown();
  aiming = false;

  // Into the LOADING ZONE: AUTO PARK is 5 more.
  yield* driveTo(robot, robot.loadingZone);
  robot.log('done at ' + robot.time.toFixed(1) + ' s with ' + robot.shooter.shots + ' shots');
}
`;
