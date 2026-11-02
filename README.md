# Swordark

A third-person sword-fighting game in the browser: freeflow combat against waves of brigands in a rain-soaked arena, ending in a duel with an armoured knight. Everything is procedural: characters, animation, textures, sound and music. There are no asset files.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173 in Chrome. Click to start, which locks the mouse. A PS5 DualSense works over USB or Bluetooth: press ✕ on the title screen. Rumble works in Chrome.

## Controls

| Action | Mouse & keyboard | DualSense |
|---|---|---|
| Move / camera | WASD / mouse | Left / right stick |
| Light slash (combo) | LMB | □ |
| Heavy cleave (hold for a leaping slam) | RMB | △ |
| Parry (hold to block) | Q | L1 |
| Dodge (into an enemy to vault over them) | Shift | ○ |
| Jump (double jump) | Space | ✕ |
| Kick (breaks guards) | F | R1 |
| Blood Art: Crimson Rend (costs one focus bar) | E | R2 |
| Lock-on (hold / toggle) | Tab or MMB | L2 hold / R3 |
| Switch lock target | Swipe mouse | Flick right stick |
| Execute an opened enemy | RMB | △ |
| In the air: slash / plunge | LMB / RMB | □ / △ |

## How the combat works

- **Timing matters more than speed.** Each slash has a window for the next input. If you press much earlier than that window, the press is dropped. Mashing ruins the chain and costs you a stumble. Pressing right on the beat gives a bonus hit (✦).
- **Guards.** An enemy holding a raised blade or a shield blocks light slashes from the front. Break the guard with a kick, a heavy, a parry or a Blood Art. If you keep comboing one enemy, they recover, block and counter-attack. Those counters can't be interrupted, so parry them.
- **Parry.** Press parry when an enemy's glint turns white. A parry opens the enemy up for a riposte or an execution. You can also parry thrown knives back at the thrower.
- **Red glints** can't be parried. Dodge or jump them. A last-instant dodge slows time and opens up the attacker.
- **Counter-hits.** Hitting an enemy early in their wind-up interrupts them and does extra damage. Once they've committed to the swing, it lands unless you parry or dodge.
- **Focus** fills when you land hits, parry, perfect-dodge and execute. Each bar spends on a Blood Art dash that cuts through everyone in a line. Blood Art unlocks after wave 1.
- **Targeting** follows the stick inside a cone. With no input, only enemies close in front get targeted. Lock-on keeps you facing your target and strafing around it.

Waves add one new thing each time: raised guards and shields, then knife throwers, then a brute with unblockable swings, then everything at once. After that comes **Vaelor, the Iron Warden**, a duel built on posture: parries break his posture, and a broken posture opens him to a deathblow. At half health his sword catches fire and he adds new moves.

## Code map

- `src/main.js`: game loop, combat resolution, executions, gore, events
- `src/actors/`: procedural skinned rig, IK animator and planted-foot gait, attack choreography (`clips.js`), player, enemy AI, boss, ragdoll, cloth, wave director
- `src/render/`: post pipeline (ink outlines, bloom, grade), materials, canvas-generated textures
- `src/world/`: arena, collision (AABBs plus the circular arena wall), rain, sky and fire
- `src/fx/`: blood (droplets, decals, spurts, pools), sparks, trails, debris
- `src/core/`: input (keyboard, mouse and gamepad with buffering), hitstop and slow-mo, camera, procedural audio

`src/world/level.js` holds the original walled courtyard level, with ramparts and props. It isn't used for now.

In dev builds, `window.dbg` exposes helpers for scripted playtests (`dbg.start(wave)`, `dbg.sim(seconds)`, `dbg.tap(action)`). Press the backtick key to show FPS.
