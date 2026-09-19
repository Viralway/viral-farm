# Coordinate profiles

Where the TikTok plugin taps. A profile is a full set of targets for one screen size, compiled into the source. `devices.json` selects one; the dashboard can nudge single points per device.

Only `iphone8` (375 × 667 points) ships today. It also fits the iPhone 7 and iPhone SE 2 and 3.

---

## What a profile holds

Defined by `DeviceCoordinates` in [`src/devices/coordinates.ts`](../src/devices/coordinates.ts). All values are points, not pixels.

| Block | Contents |
| --- | --- |
| `screenSize` | `{ width, height }` |
| `productTypes` | Apple model identifiers this layout fits, used to recommend a profile in the wizard |
| `passcodeKeypad` | Column x and row y positions for automatic unlocking |
| `tiktok` | Every tap and swipe the built-in plugin uses: tabs, create, media picker, caption, like, save, feed swipe |

```ts
export const DEVICE_COORDINATES = {
    iphone8: {
        displayName: 'iPhone 8',
        productTypes: ['iPhone10,1', 'iPhone10,4'],
        screenSize: { width: 375, height: 667 },
        passcodeKeypad: { columnX: [103, 191, 275], rowY: [220, 347, 425, 506] },
        tiktok: { profileTab: { x: 338, y: 656 } /* … */ },
    },
} satisfies Record<string, DeviceCoordinates>;

export const DEFAULT_COORDINATE_PROFILE = 'iphone8';
```

---

## How a device picks one

| Situation | Result |
| --- | --- |
| `"coordinateProfile": "<key>"` in `devices.json` | That profile |
| No key | `iphone8` |
| Unknown key | Startup error naming the file to edit |

The registration wizard lists every profile and marks the one whose `productTypes` matches the phone as recommended.

---

## Per-device calibration

Fifteen single-tap TikTok targets can be moved per device without code: `profileTab`, `homeTab`, `accountSwitcher`, `create`, `upload`, `selectMultiple`, `useLayout`, `pickerNext`, `editorNext`, `caption`, `keyboardBack`, `draft`, `finish`, `like`, `save`.

From the device page menu choose **Touch points**. Pick a target, click where it belongs on the live screen, Save. Turn on **Control device** to tap and swipe the phone from the preview until the right screen is showing; **Unlock** wakes it. Reset one point or all of them back to the profile.

Overrides are stored on the device entry and merged over the profile at runtime:

```jsonc
{
  "name": "Phone 12",
  "coordinateProfile": "iphone8",
  "coordinates": { "like": { "x": 350, "y": 320 }, "create": { "x": 190, "y": 642 } }
}
```

| Call | Effect |
| --- | --- |
| `GET /api/devices/:udid/coordinates` | Effective values and which are overridden |
| `PATCH /api/devices/:udid` with `{ "coordinates": { … } }` | Replaces the whole override map; `{}` clears it. Points are checked against the screen bounds |

The picker grid, swipe vector and keypad are not single points and stay at profile level.

---

## Adding a profile

For a materially different screen, for example iPhone 13 and 14 at 390 × 844:

1. Add a key to `DEVICE_COORDINATES` in `src/devices/coordinates.ts` with every field re-measured.
2. Mirror the `tiktok` block and `passcodeKeypad` under the same key in `src/tiktok/coordinates.ts`. The standalone TikTok entrypoints read this second copy so they can run as bare `tsx` scripts. Keep both in sync.
3. `npm run check`, redeploy `web` and `worker`, then set `"coordinateProfile"` on the matching devices.

<details>
<summary><b>Measuring targets</b></summary>

Open the live screen on the device page, or fetch `GET /api/devices/:udid/remote/screenshot`. The image is already in points. Read each target's centre, then confirm by firing `POST /api/devices/:udid/remote/action` with `{ "type": "tap", "x": …, "y": … }` and watching the phone.

</details>

---

## Why profiles are code

The profile map is a typed constant so the compiler guarantees every field exists and every `devices.json` reference resolves. A JSON-loaded profile source validated at startup would be a welcome contribution. Until then, a new geometry is a small pull request against the two files above.

Plugins cannot register profiles. The `tiktok` block is specific to the built-in plugin. A third-party plugin that taps by position should ship its own map inside the package, keyed on `device.productType` or its own `pluginData`.
