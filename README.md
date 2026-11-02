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
| Strike (freeflow combo) | LMB | □ |
| Heavy: breaks guards, executes opened enemies, special takedown at 8+ combo | RMB | △ |
| Parry (tap) / block (hold; drains guard) | Q | L2 |
| Throwing knife (interrupts wind-ups, 3 knives that regenerate) | F | R1 |
| Blood Art on the ground / ground pound in the air | E | R2 |
| Dodge (into an enemy to vault over them) | Shift | ○ |
| Jump (double jump) | Space | ✕ |
| Lock-on (hold / toggle) | Tab or MMB | L1 hold / R3 |
| Switch lock target | Swipe mouse | Flick right stick |

Add `?mute=1` to the URL to start muted.

## How the combat works

- **Freeflow.** Strikes lunge to whoever you aim the stick at (up to ~6.5m), chaining across enemies. Presses are buffered so nothing is eaten; striking right on the beat gives a bonus hit (✦). An 8-hit chain unlocks a special takedown on △.
- **Guards.** An enemy holding a raised blade or a shield blocks strikes and knives from the front. Break the guard with a heavy (△), a parry, a ground pound or a Blood Art. If you keep comboing one enemy, they recover, block and counter-attack. Those counters can't be interrupted, so parry them.
- **Knives (R1)** interrupt an enemy mid wind-up and stick in them. **Ground pound (R2 in the air)** launches everyone around you, and landing right on someone impales them.
- **Verticality.** A low dais, four stone plinths with steps and two broken pillars give you high ground. Strikes leap up to or drop down onto targets at other heights, and enemies jump up after you.
- **Parry and block.** Tap L2 as an enemy's glint turns white. A parry opens the enemy up for a riposte (□) or an execution (△). The window runs from about 0.4s before the blade lands to a hair after it (a press that comes just late still counts). Holding L2 blocks, but every blocked hit and every second you hold drains your guard meter; when it empties your guard breaks and you're open. You can also parry thrown knives back at the thrower.
- **Red glints** can't be parried. Dodge or jump them. A last-instant dodge slows time and opens up the attacker.
- **Counter-hits.** Hitting an enemy early in their wind-up interrupts them and does extra damage. Once they've committed to the swing, it lands unless you parry or dodge.
- **Focus** fills when you land hits, parry, perfect-dodge and execute. Each bar spends on a Blood Art dash that cuts through everyone in a line. Blood Art unlocks after wave 1.
- **Targeting** follows the stick inside a cone. With no input, only enemies close in front get targeted. Lock-on keeps you facing your target and strafing around it. The marker over a locked enemy shows its health and whether it's GUARDING or OPEN.
- **Steel has to meet steel.** A swing only lands if the blade actually sweeps into its target, so stepping out of range makes it miss. The freeze-frame rewinds to the exact moment of contact. On a parry, your blade snaps to the point where the enemy's sword arrives. Executions land when the blade reaches the neck, chest or skull.
- **Off-screen attackers** winding up show an arrow at the edge of the screen. It turns white when you're in the parry window, and red when the attack can't be parried.

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
