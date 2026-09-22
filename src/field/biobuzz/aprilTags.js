/**
 * The BIOBUZZ AprilTags, and where they are.
 *
 * ## What the manual settles
 *
 * Section 9.9, read from the text:
 *
 *  - 3.25 in (8.25 cm) square, family **36h11**.
 *  - Arranged in **clusters of four** on a single sticker, aligned by reference
 *    holes so the cluster's position relative to the rest of the FIELD is
 *    measurable.
 *  - Each cluster is applied **to the bottom of a CELL, facing downward toward
 *    the TILES, with its bottom edge oriented toward the centre of the FIELD**.
 *  - IDs 30-33 on the red CELL on the side opposite the audience; 34-37 on the
 *    red CELL on the audience side; 38-41 on the blue CELL on the audience
 *    side; 42-45 on the blue CELL opposite the audience.
 *
 * In this simulator's coordinates the audience is at -y and the arm runs along
 * y, so the audience-side CELL is `fore` and the far one is `aft` (see
 * `Hive._sideSign`). That fixes all sixteen IDs.
 *
 * ## What it does not, and what is assumed instead
 *
 * The *arrangement inside* a cluster is in Figure 9-15, and a figure is an
 * image. So two things here are assumptions, both recorded in
 * `INFERRED_APRILTAG`:
 *
 *  - the spacing between the four tag centres on the sticker;
 *  - which of the four IDs goes in which corner.
 *
 * They are a few inches each, and a few inches is exactly the error a robot
 * would have from a mis-specified tag library, so a routine written against
 * them behaves the way one written against a wrong library would. Everything
 * else -- the cluster's position and orientation on the CELL, the size, the
 * family, the IDs and which CELL each belongs to -- comes from the text.
 *
 * If somebody checks the figure or measures a real field, `INFERRED_APRILTAG`
 * and `clusterTags` are the only two things that need to change.
 *
 * ## Why the tags are hard to see
 *
 * Because they face *down*. A cluster on the underside of a raised CELL has its
 * normal about 30 degrees off vertical, so a camera at robot height looking
 * across the FIELD sees it almost edge-on and will not decode it. Drive under
 * the HIVE and the view steepens and it will. That is a property of the game,
 * not of the model, and it is the first thing to know before building an AUTO
 * around tag localisation.
 *
 * @module
 */
import { INCH } from '../../math/MathUtil.js';
import { CELL_DEPTH } from './constants.js';

/** Section 9.9. */
export const APRILTAG_SIZE = 3.25 * INCH;
export const APRILTAG_FAMILY = '36h11';

/**
 * Which four IDs are on which CELL, by the manual's ID list and this
 * simulator's `fore` (audience, -y) and `aft` (far, +y).
 */
export const APRILTAG_CLUSTERS = Object.freeze({
  red: Object.freeze({ aft: [30, 31, 32, 33], fore: [34, 35, 36, 37] }),
  blue: Object.freeze({ fore: [38, 39, 40, 41], aft: [42, 43, 44, 45] }),
});

/** Every ID on the FIELD, in order. */
export const APRILTAG_IDS = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45];

/** What Figure 9-15 would settle and a figure cannot. */
export const INFERRED_APRILTAG = {
  /**
   * Distance between the centres of two neighbouring tags on a cluster
   * sticker. A 3.25 in tag needs a quiet border to decode, so a 2x2 on one
   * sticker is roughly 4 in on centre; the sticker then measures about 7.25 in
   * square, which fits comfortably on a CELL bottom 20 in wide by 12 in deep.
   */
  clusterPitch: 4 * INCH,
  /**
   * Which corner each of the four IDs sits in, as offsets in (right, up) of
   * half a pitch, in the order the manual lists the IDs. Reading order: top
   * left, top right, bottom left, bottom right, where "up" is the direction the
   * cluster's bottom edge points away from -- i.e. outward along the arm.
   */
  clusterOrder: [
    [-1, 1],
    [1, 1],
    [-1, -1],
    [1, -1],
  ],
};

/**
 * @typedef {object} TagPose
 * @property {number} id
 * @property {'red'|'blue'} alliance   whose CELL it is on
 * @property {'fore'|'aft'} side
 * @property {number} size            edge length, metres
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {{x:number,y:number,z:number}} normal  out of the printed face
 * @property {{x:number,y:number,z:number}} up      bottom edge toward top edge
 * @property {{x:number,y:number,z:number}} right
 */

/**
 * The four tags on one CELL, where they are right now.
 *
 * Recomputed rather than cached because the HIVE tips: a cluster on a CELL that
 * has just gone down is 12 inches lower and pointing somewhere else, and a
 * cached pose would have a camera reading a tag through the floor.
 *
 * @param {import('./Hive.js').Hive} hive
 * @param {'fore'|'aft'} side
 * @returns {TagPose[]}
 */
export function clusterTags(hive, side) {
  const planes = hive.cellPlanes(side);
  const up3 = vec(planes.up);
  const inward = vec(planes.inward);

  // The bottom face of the CELL: down from the opening's centre to the
  // pentagon's base, then half the prism's depth inward.
  const centre = {
    x: planes.origin.x - up3.x * planes.baseOffset + inward.x * (CELL_DEPTH / 2),
    y: planes.origin.y - up3.y * planes.baseOffset + inward.y * (CELL_DEPTH / 2),
    z: planes.origin.z - up3.z * planes.baseOffset + inward.z * (CELL_DEPTH / 2),
  };

  // Out of the sticker, which is out of the CELL's floor: downward.
  const normal = scale(up3, -1);
  // The bottom edge points at the centre of the FIELD, so the top edge points
  // the other way: outward along the arm, which is the opening's own normal.
  const tagUp = scale(inward, -1);
  const right = cross(tagUp, normal);

  const ids = APRILTAG_CLUSTERS[hive.alliance][side];
  const half = INFERRED_APRILTAG.clusterPitch / 2;
  return ids.map((id, index) => {
    const [r, u] = INFERRED_APRILTAG.clusterOrder[index];
    return {
      id,
      alliance: hive.alliance,
      side,
      size: APRILTAG_SIZE,
      x: centre.x + right.x * r * half + tagUp.x * u * half,
      y: centre.y + right.y * r * half + tagUp.y * u * half,
      z: centre.z + right.z * r * half + tagUp.z * u * half,
      normal,
      up: tagUp,
      right,
    };
  });
}

/**
 * All sixteen, from both HIVES.
 * @param {{red: import('./Hive.js').Hive, blue: import('./Hive.js').Hive}} hives
 * @returns {TagPose[]}
 */
export function fieldTags(hives) {
  const out = [];
  for (const alliance of ['red', 'blue']) {
    const hive = hives[alliance];
    if (!hive) continue;
    for (const side of ['aft', 'fore']) out.push(...clusterTags(hive, side));
  }
  return out;
}

function vec(v) {
  return { x: v.x ?? 0, y: v.y ?? 0, z: v.z ?? 0 };
}

function scale(v, k) {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
