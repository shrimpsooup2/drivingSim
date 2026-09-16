/**
 * Every Game Rule in the BIOBUZZ manual, and what this simulator does about it.
 *
 * ## Why the whole list is here
 *
 * A driving simulator that models only the rules it finds convenient teaches
 * habits that lose MATCHES. The point of writing all forty down -- including
 * the ones nothing here can ever check -- is that the gaps are then *visible*:
 * you can read this file and know that the sim will catch you firing a NECTAR
 * into a FLOWER at 1:30, and that it will never catch your DRIVE COACH
 * stepping out of the ALLIANCE AREA. A rule missing from a list is a surprise
 * at an event; a rule marked `human` is a known limit.
 *
 * ## The five things a rule can be here
 *
 *   **`live`** -- `Referee` watches for it every step of a MATCH and assesses
 *   the manual's own penalty. This is where the useful practice is.
 *
 *   **`advisory`** -- detectable, but the manual's test is whether a REFEREE
 *   judged the action STRATEGIC, and the detector is a heuristic. Reported to
 *   the driver, never scored. Putting 20 points on a guess would teach people
 *   to avoid the guess rather than the foul.
 *
 *   **`structural`** -- cannot happen here, because of how the sim is built.
 *   Each of these names the mechanism, so the claim can be checked rather than
 *   believed: G427 is structural because `introduceNectar` is the only way
 *   NECTAR reaches the FIELD and it places it on the TILE inside that
 *   ALLIANCE'S own LOADING ZONE.
 *
 *   **`setup`** -- checked before the MATCH starts rather than during it. Just
 *   G304, via `Match.checkStartingPosition`.
 *
 *   **`unmodeled`** -- a real ROBOT could violate it and this one cannot,
 *   because the physics has no model for the thing the rule is about. Damage
 *   and tipping over are the whole list: the chassis is a planar 3-DOF body,
 *   so it cannot fall over, and nothing on it can break.
 *
 *   **`human`** / **`event`** -- DRIVE TEAM conduct and event logistics. There
 *   are no humans and no event here.
 *
 * ## The STRATEGIC model
 *
 * A dozen rules read "VERBAL WARNING. MAJOR FOUL and YELLOW CARD, if
 * STRATEGIC", and STRATEGIC is a REFEREE's judgement of intent, which no
 * simulator can read. But Section 10.6 says how that judgement is *reached*:
 *
 *   "multiple warnings are given during an individual MATCH for the same
 *   violation that individually can be perceived to be accidental"
 *
 * So the model here is exactly that: `assess.warnings` instances of a rule draw
 * a VERBAL WARNING, and the next one is STRATEGIC and takes the foul. It is the
 * manual's own test, which is the only defensible one available -- and it is
 * the right lesson anyway, because doing it once is forgivable and doing it
 * repeatedly is not.
 *
 * @module
 */

/**
 * Table 10-4: what a foul is worth.
 *
 * "a credit of N points towards the **opponent's** MATCH point total" -- so
 * these are added to the other ALLIANCE'S score, never subtracted from yours.
 * It reads the same on the scoreboard and is not the same thing: a MAJOR FOUL
 * against you cannot take you below the points you earned.
 */
export const PENALTY_POINTS = { minor: 5, major: 20 };

/**
 * @typedef {'live'|'advisory'|'structural'|'setup'|'unmodeled'|'human'|'event'} Coverage
 */

/**
 * @typedef {object} Assessment
 * @property {number} [warnings]  instances forgiven with a VERBAL WARNING first
 * @property {'minor'|'major'} [foul] the foul assessed once the warnings run out
 * @property {'yellow'|'red'} [card] a card alongside it
 * @property {number} [cardAfter] assessed instances before the card is shown
 * @property {'instance'|'element'|'match'} [per] what the penalty repeats over
 * @property {number} [repeatSeconds] an extra foul every N seconds uncorrected
 */

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} title
 * @property {string} penalty   the manual's own Violation line, abbreviated
 * @property {Coverage} coverage
 * @property {string} note      what this simulator does, or why it cannot
 * @property {Assessment} [assess] machine-readable penalty, for `live` rules
 */

/** @type {Rule[]} */
export const RULES = [
  // ------------------------------------------------- 11.1 / 11.2 conduct
  {
    id: 'G101',
    title: 'Humans, stay off the FIELD during the MATCH.',
    penalty: 'VERBAL WARNING',
    coverage: 'human',
    note: 'There is no human body in the sim to put on the TILES.',
  },
  {
    id: 'G102',
    title: 'Be careful when interacting with ARENA elements.',
    penalty: 'VERBAL WARNING; YELLOW CARD if STRATEGIC',
    coverage: 'human',
    note: 'Climbing on, hanging from and manipulating the ARENA are human actions.',
  },
  {
    id: 'G201',
    title: 'Be a good person.',
    penalty: 'per Section 10.6',
    coverage: 'human',
    note: 'Conduct toward people. Nothing to model.',
  },
  {
    id: 'G202',
    title: 'Follow the Competition Integrity Contract.',
    penalty: 'per Section 10.6',
    coverage: 'human',
    note: 'A team-level undertaking, signed before the event.',
  },
  {
    id: 'G203',
    title: 'Show up to your MATCHES.',
    penalty: 'Surrogate / no-show handling',
    coverage: 'event',
    note: 'Attendance at a scheduled MATCH. The sim starts when you press start.',
  },
  {
    id: 'G204',
    title: 'Do not expect to gain by doing others harm.',
    penalty: 'per Section 10.6',
    coverage: 'human',
    note:
      'Actions aimed at forcing an opponent to violate a rule. Turns entirely on intent, ' +
      'and the manual assigns the opponent’s penalty to the instigator -- a call no ' +
      'detector can make.',
  },
  {
    id: 'G205',
    title: 'Egregious or exceptional violations.',
    penalty: 'Head REFEREE discretion, up to RED CARD',
    coverage: 'human',
    note: 'The rule that exists so the Head REFEREE is not bound by the list.',
  },

  // --------------------------------------------------- 11.3 pre-MATCH
  {
    id: 'G301',
    title: 'Do not delay MATCHES.',
    penalty: 'VERBAL WARNING; MAJOR FOUL for the upcoming MATCH',
    coverage: 'event',
    note: 'Queueing and field reset, between MATCHES.',
  },
  {
    id: 'G302',
    title: 'Limit what you bring to the FIELD.',
    penalty: 'VERBAL WARNING; MINOR FOUL if not corrected',
    coverage: 'event',
    note: 'What fits in the ALLIANCE AREA. Nothing is carried to the FIELD here.',
  },
  {
    id: 'G303',
    title: 'ROBOTS on the FIELD must come ready to play.',
    penalty: 'VERBAL WARNING; not permitted to play',
    coverage: 'event',
    note:
      'Inspection, battery, and the ROBOT being present and MATCH-ready. The sim’s ' +
      'ROBOT is always inspected and always has a battery -- which is modelled, and sags.',
  },
  {
    id: 'G304',
    title: 'ROBOTS must be set up correctly on the FIELD.',
    penalty: 'Corrected before the MATCH; MINOR FOUL if not',
    coverage: 'setup',
    note:
      '`Match.checkStartingPosition` tests all five clauses -- own side, inside the ' +
      'perimeter, touching the wall, clear of every FLOWER, out of the LOADING ZONE -- and ' +
      '`BiobuzzGame.stageRobots` only ever uses a position that passes it.',
  },
  {
    id: 'G305',
    title: 'Teams must select an OpMode.',
    penalty: 'VERBAL WARNING; MINOR FOUL if not corrected',
    coverage: 'structural',
    note: 'An op-mode is always selected and initialised: the sim has nothing else to run.',
  },

  // ------------------------------------------------------ 11.4.1 AUTO
  {
    id: 'G401',
    title: 'Do not interact with a ROBOT during AUTO.',
    penalty: 'VERBAL WARNING; MAJOR FOUL and YELLOW CARD per MATCH if STRATEGIC',
    coverage: 'live',
    assess: { warnings: 1, foul: 'major', card: 'yellow', per: 'match' },
    note:
      'The sim deliberately leaves the sticks live during AUTO, because taking them away ' +
      'would make the period unusable until pasted AUTO code lands. So driving in AUTO is ' +
      'possible and is called: the first second of it is a warning, sustained driving is ' +
      'the foul.',
  },
  {
    id: 'G402',
    title: 'No AUTO opponent interference.',
    penalty: 'MAJOR FOUL per MATCH; MAJOR FOUL and YELLOW CARD if STRATEGIC',
    coverage: 'live',
    assess: { foul: 'major', card: 'yellow', cardAfter: 1, per: 'match' },
    note:
      'Called on the detectable half: during AUTO, contacting an opponent ROBOT while ' +
      'across the centre line on their side of the FIELD. Crossing alone is reported as ' +
      'advisory, because the manual only says it "may be seen as STRATEGIC".',
  },
  {
    id: 'G403',
    title: 'ROBOTS are motionless between AUTO and TELEOP.',
    penalty: 'VERBAL WARNING; MAJOR FOUL and YELLOW CARD per MATCH if STRATEGIC',
    coverage: 'live',
    assess: { warnings: 1, foul: 'major', card: 'yellow', per: 'match' },
    note:
      'Powered movement during the 8-second transition. Measured as commanded effort -- ' +
      'drive duty or a running MECHANISM -- not as motion, because the rule exempts ' +
      'movement "due to inertia, gravity, or de-energizing of actuators".',
  },
  {
    id: 'G404',
    title: 'ROBOTS are motionless at the end of TELEOP.',
    penalty: 'VERBAL WARNING; MAJOR FOUL and YELLOW CARD per MATCH if STRATEGIC',
    coverage: 'live',
    assess: { warnings: 1, foul: 'major', card: 'yellow', per: 'match' },
    note:
      'The same test as G403, after the buzzer. Worth practising: a flywheel left spinning ' +
      'is powered movement, and the habit of letting go of everything at 0:00 is the one ' +
      'the rule is asking for.',
  },
  {
    id: 'G405',
    title: 'Keep SCORING ELEMENTS in bounds.',
    penalty: 'MAJOR FOUL per SCORING ELEMENT',
    coverage: 'live',
    assess: { foul: 'major', per: 'element' },
    note:
      'Every element that leaves the FIELD is attributed from what last touched it. A ' +
      'LAUNCHED element is a scoring attempt and a squeeze between two ROBOTS is a ' +
      'ROBOT-to-ROBOT interaction -- the rule exempts both by name -- so only an element ' +
      'a ROBOT carried, shoved or spat over the wall is a foul. Either way it comes back: ' +
      'see Section 10.8.2 and `BiobuzzField.returnElements`.',
  },
  {
    id: 'G406',
    title: 'Do not damage or make a mess in the ARENA.',
    penalty: 'VERBAL WARNING; MAJOR FOUL and YELLOW CARD if STRATEGIC',
    coverage: 'unmodeled',
    note:
      'Nothing here can be damaged: the TILES, the walls and the structures are rigid and ' +
      'permanent. Ramming the HIVE frame is caught, but as G417.',
  },
  {
    id: 'G407',
    title: 'No more than 4 at a time.',
    penalty: 'VERBAL WARNING; MAJOR FOUL and YELLOW CARD per MATCH if STRATEGIC',
    coverage: 'live',
    assess: { warnings: 1, foul: 'major', card: 'yellow', per: 'match' },
    note:
      'Counts the elements a ROBOT has taken ownership of -- its intake and anything its ' +
      'grabber holds. Deliberately not bulldozed or deflected elements, both of which the ' +
      'rule lists as not CONTROL.',
  },
  {
    id: 'G408',
    title: 'Do not CONTROL opponent NECTAR.',
    penalty: 'VERBAL WARNING; YELLOW CARD per MATCH if STRATEGIC',
    coverage: 'live',
    assess: { warnings: 1, card: 'yellow', per: 'match' },
    note:
      'A NECTAR of the other colour held by a ROBOT. No foul points at any tier -- the ' +
      'manual gives this one a warning and then a card -- so it shows in the citation list ' +
      'without moving the score. Mostly unreachable by default, because the intake senses ' +
      'the colour and refuses one, which is what a real ROBOT does with an element that is ' +
      'worth nothing to it. Turn "Intake rejects opponent NECTAR" off to drill the hazard, ' +
      'and then steering around the other colour is the driver\u2019s job.',
  },
  {
    id: 'G409',
    title: 'Do not catch SCORING ELEMENTS.',
    penalty: 'VERBAL WARNING; YELLOW CARD per MATCH if STRATEGIC',
    coverage: 'live',
    assess: { warnings: 2, card: 'yellow', per: 'match' },
    note:
      'Elements let go by a TIPPING HIVE are flagged until they touch anything that is not ' +
      'the ROBOT -- the TILES, a wall, the frame, another element -- and a ROBOT contact ' +
      'while the flag is up is the catch. Two are forgiven, which matches the rule’s own ' +
      'examples: one or two POLLEN landing on a ROBOT driving past is not a violation, ' +
      'sitting under the HIVE waiting is.',
  },
  {
    id: 'G410',
    title: 'NECTAR only goes into FLOWERS with one minute left.',
    penalty: 'MAJOR FOUL per NECTAR',
    coverage: 'live',
    assess: { foul: 'major', per: 'element' },
    note:
      'Counted on entry to the FLOWER scoring volume, not prevented -- the element still ' +
      'scores and the ALLIANCE takes the foul, which is how a REFEREE handles it.',
  },
  {
    id: 'G411',
    title: 'Do not hoard SCORING ELEMENTS.',
    penalty: 'MAJOR FOUL and YELLOW CARD per MATCH',
    coverage: 'advisory',
    note:
      'Corralling is detectable -- a cluster of loose elements with an ALLIANCE ROBOT ' +
      'parked on it -- but the rule turns on STRATEGICALLY denying access, and the GARDENS ' +
      'start with a legitimate cluster in them. This one has no warning tier, so a false ' +
      'positive would be 20 points and a card off a heuristic. Reported, never scored.',
  },
  {
    id: 'G412',
    title: 'ROBOTS must be under control.',
    penalty: 'DISABLED and VERBAL WARNING',
    coverage: 'structural',
    note:
      'About hazards *outside* the FIELD: flailing over the wall, knocking over a DRIVER ' +
      'STATION, contacting FIELD STAFF. The sim has a closed perimeter and nothing outside ' +
      'it, and an element that leaves is G405.',
  },
  {
    id: 'G413',
    title: 'ROBOTS must stop when instructed.',
    penalty: 'RED CARD',
    coverage: 'event',
    note: 'There is no REFEREE channel to instruct a stop, and no reason to ignore one.',
  },
  {
    id: 'G414',
    title: 'ROBOTS must be identifiable.',
    penalty: 'VERBAL WARNING; YELLOW CARD if STRATEGIC',
    coverage: 'event',
    note: 'Team numbers and ALLIANCE markings, which the renderer assigns and cannot lose.',
  },
  {
    id: 'G415',
    title: 'Watch your ARENA interaction.',
    penalty: 'VERBAL WARNING; YELLOW CARD if STRATEGIC',
    coverage: 'structural',
    note:
      'Grabbing, attaching to or suspending from an ARENA element. No mechanism here can ' +
      'take hold of anything but a SCORING ELEMENT, which the rule exempts, and the ' +
      'concave FLOWER-alignment shape it explicitly allows is what the grabber archetypes ' +
      'use.',
  },
  {
    id: 'G416',
    title: 'ROBOTS have construction limits.',
    penalty: 'MAJOR FOUL per instance',
    coverage: 'structural',
    note:
      'The R105 expansion volume during a MATCH. The sim’s chassis has a fixed footprint ' +
      'and its mechanisms do not extend past it, so the limit is never approached.',
  },
  {
    id: 'G417',
    title: 'ROBOTS may not meddle with the HIVE Structure.',
    penalty: 'VERBAL WARNING; MAJOR FOUL and YELLOW CARD per MATCH if STRATEGIC',
    coverage: 'live',
    assess: { warnings: 1, foul: 'major', card: 'yellow', per: 'match' },
    note:
      'Two detectors, matching the rule’s own examples. Driving into the HIVE frame above ' +
      'a walking pace is example A/B ("ramming into the HIVE frame at high-speed"); a ' +
      'LAUNCHED element striking the *opponent’s* HIVE is example D ("impeding the TIP of ' +
      'an opponent’s HIVE by LAUNCHING at it"). Missing your own CELL and hitting its ' +
      'outside is example H and explicitly not a violation, so it is not called.',
  },
  {
    id: 'G418',
    title: 'ROBOTS may not meddle with FLOWERS.',
    penalty: 'VERBAL WARNING; MAJOR FOUL and YELLOW CARD per MATCH if STRATEGIC',
    coverage: 'structural',
    note:
      'Both clauses are built into the geometry. `Flower.interactBall` only captures an ' +
      'element descending through the top ring, so there is no other way in; ' +
      '`Flower.removeBottom` refuses anything wider than the 3.55 in retrieval gap, so a ' +
      'NECTAR cannot come out at all and a NECTAR at the bottom plugs the tube.',
  },
  {
    id: 'G419',
    title: 'Do not damage an opponent ROBOT.',
    penalty: 'VERBAL WARNING; MAJOR FOUL and YELLOW CARD per instance if STRATEGIC',
    coverage: 'unmodeled',
    note:
      'No damage model. A ROBOT here is a rigid box with a drivetrain: there is nothing to ' +
      'disconnect, bend or switch off, so a high-speed ram is only a collision.',
  },
  {
    id: 'G420',
    title: 'Do not tip or entangle.',
    penalty: 'VERBAL WARNING; MAJOR FOUL and YELLOW CARD per instance if STRATEGIC',
    coverage: 'unmodeled',
    note:
      'The chassis is a planar 3-DOF body -- x, y and heading -- so it cannot leave the ' +
      'floor or fall over, and nothing on it can entangle. The load-transfer model does ' +
      'report when a ROBOT would tip, but it does not then tip it.',
  },
  {
    id: 'G421',
    title: 'There is a 3-count on PINS.',
    penalty: 'MAJOR FOUL per instance, and another every 3 seconds uncorrected',
    coverage: 'live',
    assess: { foul: 'major', per: 'instance', repeatSeconds: 3 },
    note:
      'The full count, with all three end conditions and both pause clauses: the count ' +
      'pauses at 2 ft of separation and resumes if the pinner closes back in, pauses once ' +
      'either ROBOT has moved 2 ft from where the pin began, and ends outright if the ' +
      'pinner gets pinned.',
  },

  // ------------------------------------------------------ 11.4.6 human
  {
    id: 'G422',
    title: 'DRIVE TEAM stays in the ALLIANCE AREA.',
    penalty: 'VERBAL WARNING; MINOR FOUL per instance if STRATEGIC',
    coverage: 'human',
    note: 'Where the people stand.',
  },
  {
    id: 'G423',
    title: 'DRIVE COACHES and other teams: hands off the controls.',
    penalty: 'VERBAL WARNING; MINOR FOUL per instance if STRATEGIC',
    coverage: 'human',
    note: 'Who is holding the gamepad. The sim has one seat and cannot see who is in it.',
  },
  {
    id: 'G424',
    title: 'DRIVE COACHES, SCORING ELEMENTS are off limits.',
    penalty: 'VERBAL WARNING; MINOR FOUL per instance if STRATEGIC',
    coverage: 'human',
    note: 'A human touching an element. The only human action modelled is entering NECTAR.',
  },
  {
    id: 'G425',
    title: 'DRIVE TEAMS, watch your reach.',
    penalty: 'VERBAL WARNING; MINOR FOUL per instance if STRATEGIC',
    coverage: 'human',
    note:
      'Reaching into the FIELD. `introduceNectar` places a NECTAR on the TILES in the ' +
      'LOADING ZONE and touches nothing else, which is the compliant version of the one ' +
      'reach the sim performs.',
  },
  {
    id: 'G426',
    title: 'Humans may not enter NECTAR onto the FIELD early.',
    penalty: 'MINOR FOUL per NECTAR',
    coverage: 'structural',
    note:
      'The release schedule is the gate: `BiobuzzField.unlockNectar` hands over one NECTAR ' +
      'per TIP and the remainder at 60 seconds, and `introduceNectar` returns null when ' +
      'nothing is unlocked. There is no way to enter one early.',
  },
  {
    id: 'G427',
    title: 'Humans, only enter NECTAR via the LOADING ZONE.',
    penalty: 'MINOR FOUL per NECTAR',
    coverage: 'structural',
    note:
      '`introduceNectar` is the only path onto the FIELD, and it places the NECTAR at rest ' +
      'on the TILES inside its own ALLIANCE’S LOADING ZONE -- contacting the TILE first, ' +
      'as clause C requires, by its own colour, with no tool.',
  },
  {
    id: 'G428',
    title: 'Humans, do not remove SCORING ELEMENTS from the FIELD.',
    penalty: 'MINOR FOUL per SCORING ELEMENT',
    coverage: 'structural',
    note:
      'No human hand can pick anything up. The only route off the FIELD is a ROBOT putting ' +
      'it there, which is G405, and FIELD STAFF putting it back, which is Section 10.8.2.',
  },
];

/** @type {Map<string, Rule>} */
export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/**
 * @param {string} id
 * @returns {Rule}
 */
export function rule(id) {
  const found = RULES_BY_ID.get(id);
  if (!found) throw new Error(`no such rule: ${id}`);
  return found;
}

/**
 * Rules grouped by what the sim does about them, for the docs and the panel.
 * @returns {Record<Coverage, Rule[]>}
 */
export function rulesByCoverage() {
  /** @type {any} */
  const out = {};
  for (const r of RULES) (out[r.coverage] ??= []).push(r);
  return out;
}

/**
 * Points a foul credits to the opponent.
 * @param {'minor'|'major'} foul
 */
export function foulPoints(foul) {
  return PENALTY_POINTS[foul] ?? 0;
}
