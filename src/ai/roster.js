import { ROBOT_ARCHETYPES, ARCHETYPE_BY_ID, BUILD_QUALITIES } from './archetypes.js';
import { SKILL_LEVELS, SKILL_BY_ID } from './profiles.js';

/**
 * The other three robots in the MATCH.
 *
 * An FTC MATCH is four ROBOTS: you, one ALLIANCE partner, and two opponents.
 * This turns the settings for those three slots into opponent specifications.
 *
 * All three are configured the same way and by the same code, which is
 * deliberate. A partner who cannot shoot is every bit as much a thing to
 * practise around as an opponent who can -- arguably more, because you cannot
 * push your partner out of the way. And a rough partner with a good driver
 * plays quite unlike a good robot with a rough one, so skill, archetype and
 * build quality are chosen independently for each.
 *
 * `'random'` on any field rolls it per slot, so "three random robots" gives a
 * different match every time without anyone having to think up a line-up.
 *
 * @module
 */

/** The three slots, in the order the UI shows them. */
export const ROSTER_SLOTS = [
  {
    id: 'partner',
    label: 'Alliance partner',
    side: 'own',
    help: 'On your side. Helps, or does not, and you cannot move it out of the way.',
  },
  {
    id: 'opponent1',
    label: 'Opponent 1',
    side: 'other',
    help: 'On the other side.',
  },
  {
    id: 'opponent2',
    label: 'Opponent 2',
    side: 'other',
    help: 'On the other side.',
  },
];

/** Options for the archetype picker, with `random` first. */
export const ARCHETYPE_OPTIONS = [
  { value: 'random', label: 'Random' },
  ...ROBOT_ARCHETYPES.map((a) => ({ value: a.id, label: `${a.name} - ${a.system}` })),
];

export const QUALITY_OPTIONS = [
  { value: 'random', label: 'Random' },
  ...BUILD_QUALITIES.map((q) => ({ value: q.id, label: q.name })),
];

export const SKILL_OPTIONS = [
  { value: 'random', label: 'Random' },
  ...SKILL_LEVELS.map((s) => ({ value: s.id, label: s.name })),
];

/**
 * Turn the roster settings into opponent specs.
 *
 * Returns only the slots that are switched on, each with a concrete archetype,
 * quality and skill -- `random` is resolved here, once, rather than re-rolled
 * every time something reads the config, so a robot does not change what it is
 * halfway through a MATCH.
 *
 * Deliberately does *not* place them: where a ROBOT may legally start is
 * G304's business and `BiobuzzGame.stageRobots` already answers it for every
 * participant. Two places deciding that is how one of them ends up wrong.
 *
 * @param {object} rosterConfig the `ai` config group
 * @param {'red'|'blue'} playerAlliance
 * @param {() => number} [random]
 * @returns {{slot: string, archetypeId: string, qualityId: string, skillId: string,
 *            alliance: 'red'|'blue', behavior: string, id: string}[]}
 */
export function buildRoster(rosterConfig, playerAlliance, random = Math.random) {
  const other = playerAlliance === 'red' ? 'blue' : 'red';
  const out = [];
  for (const slot of ROSTER_SLOTS) {
    const settings = rosterConfig?.[slot.id];
    if (!settings || settings.enabled === false) continue;

    const archetypeId = resolve(settings.archetype, ROBOT_ARCHETYPES, random);
    const qualityId = resolve(settings.quality, BUILD_QUALITIES, random);
    const skillId = resolve(settings.skill, SKILL_LEVELS, random);
    const archetype = ARCHETYPE_BY_ID[archetypeId];

    out.push({
      slot: slot.id,
      id: `${slot.id}-${archetypeId}`,
      archetypeId,
      qualityId,
      skillId,
      alliance: slot.side === 'own' ? playerAlliance : other,
      // The fallback for a bare field, where there is no game to play. A robot
      // built to defend keeps defending; everything else just chases, which is
      // the old drill behaviour and is at least something to drive around.
      behavior: archetype?.role === 'defender' ? 'blocker' : 'chaser',
    });
  }
  return out;
}

/**
 * Describe a resolved roster in one line per robot, for a panel or a log.
 * @param {ReturnType<typeof buildRoster>} roster
 */
export function describeRoster(roster) {
  return roster.map((entry) => {
    const archetype = ARCHETYPE_BY_ID[entry.archetypeId];
    const skill = SKILL_BY_ID[entry.skillId];
    const quality = BUILD_QUALITIES.find((q) => q.id === entry.qualityId);
    return `${entry.slot} (${entry.alliance}): ${archetype?.name ?? entry.archetypeId} -- ${quality?.name ?? entry.qualityId}, ${skill?.name ?? entry.skillId}`;
  });
}

/** Pick one of `list`'s ids, or keep `value` when it names one. */
function resolve(value, list, random) {
  if (value && value !== 'random' && list.some((item) => item.id === value)) return value;
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))].id;
}
