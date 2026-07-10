# 🧊 Liquid Lens Navbar Card

A bottom navigation bar for Home Assistant dashboards with an **iOS-26-style
"liquid glass" lens** that follows your finger as you drag across the bar —
plus per-route status dots and live-templated icon colors.

- Drag across the bar and a frosted glass lens tracks your finger, with a
  soft light-refraction fringe at the edges
- Icons switch popups **live** as the lens passes over them — no need to
  lift your finger
- Optional colored status dots per route (e.g. "is anything running?"),
  each driven by its own JS template evaluated against live entity states
- Optional icon recoloring the same way (`icon_color`)
- Light haptic pulse (native on the Companion App, `navigator.vibrate`
  fallback in-browser) as the lens crosses into a new icon
- Theme-aware: icons use `var(--primary-text-color)`, so they stay legible
  in both light and dark themes

![demo](https://github.com/donsebby/liquid-lens-navbar-card/blob/main/asset/demo.gif)

> Built for and tested against Home Assistant's `sections` dashboard type,
> alongside [Bubble Card](https://github.com/Clooos/Bubble-Card) pop-ups
> for navigation targets. It doesn't depend on Bubble Card, but the
> hash-based `#my-popup` navigation style matches how Bubble Card pop-ups
> listen for hash changes.

## Installation

### HACS (custom repository)

1. HACS → the `⋮` menu (top right) → **Custom repositories**
2. Add this repository's URL, category **Dashboard**
3. Install **Liquid Lens Navbar Card**, then reload your browser

### Manual

1. Download `liquid-lens-navbar-card.js` from this repo
2. Copy it to `<config>/www/liquid-lens-navbar-card.js`
3. Settings → Dashboards → Resources → add resource:
   - URL: `/local/liquid-lens-navbar-card.js`
   - Type: JavaScript Module
4. Hard-refresh your browser (and fully restart the Companion App if you
   use it, since it caches resources more aggressively than a browser tab)

## Basic usage

```yaml
type: custom:liquid-lens-navbar-card
routes:
  - icon: mdi:lightbulb-group
    label: Lights
    tap_action:
      action: navigate
      navigation_path: "#lights-popup"
  - icon: mdi:power-socket-de
    label: Outlets
    tap_action:
      action: navigate
      navigation_path: "#outlets-popup"
  - icon: mdi:thermometer
    label: Climate
    tap_action:
      action: navigate
      navigation_path: "/lovelace-home/climate"
```

Place the card as the **last card** in your dashboard's section/view — it
renders itself `position: fixed` at the bottom of the screen regardless of
where it sits in the layout, so its position in the YAML doesn't matter,
but keeping it last avoids confusing the visual editor.

## Config reference

| Option        | Type    | Required | Description                                                                 |
| ------------- | ------- | -------- | ---------------------------------------------------------------------------- |
| `routes`      | array   | yes      | The icons in the bar, in order. See below.                                   |
| `hide_labels` | boolean | no       | Hide the text label under every icon (default: `false`, labels shown).       |
| `icon_size`   | number  | no       | Size of the icon inside each button, in px (default: `24`).                  |
| `item_gap`    | number  | no       | Gap between buttons in the bar, in px (default: `4`).                        |
| `button_size` | number  | no       | Width/height of each tap target, in px (default: `54`).                      |
| `lens_width`  | number  | no       | Width of the tracking lens, in px (default: `button_size + item_gap * 2`).   |

If icons feel cramped or hard to hit accurately (common on narrow phone
screens or with many routes), raise `item_gap` and/or `button_size`:

```yaml
type: custom:liquid-lens-navbar-card
icon_size: 26
item_gap: 10
button_size: 62
routes:
  - icon: mdi:home
    label: Home
    tap_action:
      action: navigate
      navigation_path: "#home"
```

`lens_width` usually doesn't need to be set manually — it auto-scales
with `button_size` and `item_gap` so the lens keeps covering one
button's worth of space. Only override it if the lens visually looks
too narrow/wide after changing the other two.

### Route object

| Option        | Type   | Required | Description                                                                     |
| ------------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `icon`        | string | yes      | Any `mdi:` icon name.                                                            |
| `label`       | string | no       | Text under the icon. Ignored per-route if `hide_labels: true` on the card.       |
| `tap_action`  | object | no       | `navigate` or `call-service`/`perform-action`. See below.                        |
| `icon_color`  | string | no       | A CSS color, or a `[[[ ... ]]]` JS template. See "Templates" below.              |
| `dots`        | array  | no       | Small status dots rendered under the icon. Each item: `{ color: <template> }`.   |

### `tap_action`

Two action types are supported:

```yaml
tap_action:
  action: navigate
  navigation_path: "#some-popup"   # hash navigation (e.g. Bubble Card pop-ups)
# or
  navigation_path: "/lovelace-home/some-view"   # normal HA view navigation
```

```yaml
tap_action:
  action: perform-action   # or the legacy alias "call-service"
  service: light.toggle    # e.g. domain.service
  target:
    entity_id: light.living_room
  service_data: {}          # optional
```

### Templates (`icon_color` and `dots[].color`)

Both accept either a plain CSS color string, or a JS expression wrapped in
`[[[ ... ]]]` and evaluated live against `hass.states` on every state
change. `states` is a plain object keyed by `entity_id`, mirroring
`hass.states` — **not** a Jinja/Python template, this is JavaScript.

```yaml
icon_color: "[[[ return states['alarm_control_panel.home'].state.startsWith('armed') ? '#F44336' : null; ]]]"
```

Return `null`/`undefined`/`''` to fall back to the default color (theme
text color for icons, neutral gray for dots).

Multiple entities:

```yaml
dots:
  - color: >-
      [[[
        const vacuums = ['vacuum.a', 'vacuum.b'];
        return vacuums.some(e => states[e] && states[e].state === 'cleaning')
          ? '#00BFA5' : null;
      ]]]
```

> ⚠️ These templates run as raw `new Function(...)` in the browser. Only
> use templates you wrote or trust — this card does not sandbox them
> beyond what the browser itself does.

## Known limitations

- **No real optical distortion.** The lens uses blur/saturation/brightness
  plus faked chromatic-fringe shadows to *suggest* glass refraction — true
  pixel-level distortion (`feDisplacementMap` via `backdrop-filter`) was
  tested and found unreliable across WebKit-based WebViews (specifically,
  it did not render at all in the HA Companion App's WKWebView, even
  though the same technique works in desktop/mobile Safari). If Apple's
  actual Liquid Glass shader ever becomes accessible from CSS, this could
  be revisited.
- Every icon must have an entry in `routes`; there's no built-in "more"
  overflow menu for bars with many icons — group related items into a
  single popup with sub-sections instead (see the "Design notes" below).
- Not tested with a fixed `header` bar or a dashboard using `type: masonry`
  (only `type: sections`).

## Design notes / FAQ

**Why does my navbar look cramped with 6+ icons?**
Consider merging related, less-frequently-used icons into one route whose
popup shows all of them directly (headings + content, not more taps) —
rather than adding a generic catch-all "more" menu, which tends to feel
like a dumping ground. A collapsed `custom:expander-card` per section
inside that popup keeps heavy content (camera feeds, maps) from loading
until the user actually opens that section.

**The popup opens/closes animation feels slow.**
If you're using [Bubble Card](https://github.com/Clooos/Bubble-Card)
pop-ups as navigation targets, their default transition is roughly
0.3–0.5s. You can override it with
[card-mod](https://github.com/thomasloven/lovelace-card-mod):

```yaml
card_mod:
  style: |
    .bubble-pop-up { transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.3, 1) !important; }
    .bubble-backdrop { transition: opacity 0.15s ease-out !important; }
```

## License

MIT — see [LICENSE](LICENSE).

## Credits

Built iteratively in conversation with Claude (Anthropic) against a real
Home Assistant dashboard, then cleaned up for public release.
