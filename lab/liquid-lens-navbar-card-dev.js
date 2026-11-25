/**
 * Lens Navbar Card (formerly Liquid Lens Navbar Card)
 * ----------------------------------------------------
 * v2.0.0: part of the "Pane" card family - the card brings structure, the
 * theme brings the look. The bar reads the Pane theme variables
 * (--pane-surface, --pane-blur, --pane-backdrop, --pane-border,
 * --pane-accent) and `--pane-effects: none` switches off the glass lens
 * and sheen. The card type is now `lens-navbar-card-dev`; the old type
 * `liquid-lens-navbar-card-dev` keeps working as an alias.
 *
 * A bottom navigation bar for Home Assistant dashboards with an
 * iOS-26-style "liquid glass" lens that follows your finger as you
 * drag across the bar, plus optional per-route status dots, a live
 * value readout per route, and JS-templated icon symbols/colors.
 *
 * The bar is capped to a max width per display (`max_width`, or
 * `calc(100vw - 32px)` by default). If the routes don't fit, the bar
 * becomes horizontally scrollable - drag the lens to the visible edge
 * and the icon row keeps auto-scrolling underneath it, revealing more
 * routes while the lens stays pinned to your finger at the edge.
 * Releasing the drag snaps a partially-clipped edge route fully into
 * view instead of leaving it half-cut-off.
 *
 * The route matching the current `location.hash` (or view path, for
 * plain navigation targets) is highlighted persistently, independent
 * of the drag-hover highlight. An optional `pulse` template per route
 * (same [[[ ... ]]] convention as icon_color) makes the icon pulse,
 * e.g. for a triggered alarm.
 *
 *
 * Popups only load once the lens settles on an icon - navigation is
 * debounced by a short hover delay (`hover_delay`, default 130ms)
 * rather than firing on every icon the lens passes over while
 * dragging. This avoids the jank of rapidly mounting/unmounting a
 * popup for every icon crossed on a fast swipe (noticeable on iOS).
 * Releasing the drag always finalizes navigation immediately,
 * regardless of the delay. Setting `release_only: true` disables
 * hover-triggered navigation entirely - popups then only ever open on
 * release, never mid-drag.
 *
 * Edit-mode detection crosses shadow-DOM boundaries and checks for any
 * enclosing dialog, so the fixed-position bar switches to normal
 * document flow inside the card editor/preview - otherwise the
 * editor dialog's own CSS transform turns it into the containing
 * block for `position: fixed`, and the bar ends up pinned over (and
 * blocking taps on) the dialog's Save button instead of the screen edge.
 *
 * Templates (icon/icon_color/value_color/pulse/dots[].color) are compiled
 * once per unique template string and cached on the instance, rather than
 * re-parsed via `new Function(...)` on every `set hass` call (which fires
 * on every state change anywhere in Home Assistant, not just for entities
 * this card cares about).
 *
 * `value_entity` state text is rendered through `hass.formatEntityState`,
 * so it shows in the dashboard's configured language (e.g. "Ein"/"Aus")
 * instead of the raw English state string, with a safe fallback for
 * older cores that don't expose that helper.
 *
 * v1.5.3: hash-based `navigate` actions (e.g. `#my-popup`) now use
 * `history.pushState` plus a manually dispatched `hashchange` event
 * instead of a native `location.hash` assignment. The native assignment
 * was found to trigger a brief reload/flash of the whole dashboard on
 * the iOS Companion App's WKWebView on every hash-based popup
 * navigation - not reproducible on Android or desktop browsers. Bubble
 * Card and this card's own active-route highlighting are unaffected,
 * since both only listen for the `hashchange` event either way.
 *
 * v1.6.0: optional `modes` - several route sets in one bar (e.g. a
 * "Home" set for everyone and a "Tech" set for admins). Swipe the bar
 * up or down to switch; the new icons morph in, small dots above the
 * bar show which mode is active, and a short toast shows the mode's
 * name. A hidden mode's dot lights up in the first status color of its
 * routes' `dots`, so an alert in the other mode is never invisible.
 * The active mode follows the URL: opening a popup or view that
 * belongs to another mode switches to it. A plain `routes` config
 * keeps working exactly as before (it is simply one mode).
 *
 * Also in v1.6.0: optional `peek` per route - while the lens rests on an
 * icon, a small glass card above the bar shows a live summary of that
 * route (text plus up to four bars, all templatable). Releasing opens
 * the popup as before; routes with a peek don't open it mid-drag.
 *
 * v1.7.0: optional `visibility` on routes and on modes, using the same
 * condition list as a Lovelace card's `visibility` (user, state,
 * numeric_state, and/or/not). One card can now serve family and admins:
 * hidden routes are simply not rendered, hidden modes are skipped when
 * switching, and a bar left with a single visible mode behaves exactly
 * like a plain `routes` bar. Conditions are re-checked on hass updates,
 * but the buttons are only rebuilt when the visible set really changes.
 *
 * https://github.com/donsebby/liquid-lens-navbar-card-dev (to be renamed lens-navbar-card-dev)
 * License: MIT
 */

const CARD_VERSION = '2.0.1-dev';

// Unknown `visibility` condition types are treated as "visible" (so a
// typo or a newer Lovelace condition never hides a route for good), but
// warned about once per type - not on every hass update.
const LLN_WARNED_CONDITIONS = new Set();
const LLN_ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

// eslint-disable-next-line no-console
console.info(
  `%c LIQUID-LENS-NAVBAR-CARD %c v${CARD_VERSION} `,
  'color: white; background: #7c3aed; font-weight: 700;',
  'color: #7c3aed; background: white; font-weight: 700;'
);

class LensNavbarCard extends HTMLElement {
  // Accepts either a single `routes` array (the classic config) or a
  // `modes` array of `{ name, path?, routes }` objects. Internally both
  // are normalized to a list of modes, so everything below only ever
  // deals with "the routes of the current mode" via this._routes().
  setConfig(config) {
    if (!config) throw new Error('lens-navbar-card-dev: missing config');
    let modes;
    if (Array.isArray(config.modes) && config.modes.length > 0) {
      modes = config.modes;
    } else if (Array.isArray(config.routes) && config.routes.length > 0) {
      modes = [{ routes: config.routes }];
    } else {
      throw new Error('lens-navbar-card-dev: "routes" (or "modes") must be a non-empty array');
    }
    // A typo like `visibility: admin` would otherwise silently count as
    // "no conditions" and show an admin route to everyone.
    const checkVisibility = (vis, where) => {
      if (vis != null && typeof vis !== 'object') {
        throw new Error(`lens-navbar-card-dev: ${where}.visibility must be a list of conditions`);
      }
    };
    modes.forEach((mode, mi) => {
      if (!mode || !Array.isArray(mode.routes) || mode.routes.length === 0) {
        throw new Error(`lens-navbar-card-dev: modes[${mi}].routes must be a non-empty array`);
      }
      checkVisibility(mode.visibility, `modes[${mi}]`);
      mode.routes.forEach((route, ri) => {
        const where = config.modes ? `modes[${mi}].routes[${ri}]` : `routes[${ri}]`;
        if (!route.icon) {
          throw new Error(`lens-navbar-card-dev: ${where} is missing "icon"`);
        }
        checkVisibility(route.visibility, where);
      });
    });
    this.config = config;
    this._modes = modes;
    this._initVisibility();
    if (this._modeIndex == null || this._modeIndex >= this._view.length) {
      this._modeIndex = this._modeForLocation() ?? 0;
    }
    this._rendered = false;
    this._render();
  }

  // Routes of the currently visible mode. `this._modes` is the full
  // config; `this._view` is the part of it this user may see right now
  // (see _computeView), and everything at runtime - indices, swipes, mode
  // dots - works on the view, so hidden routes can't be reached at all.
  _routes() {
    const mode = this._view && this._view[this._modeIndex];
    return mode ? mode.routes : [];
  }

  // Populates a sensible default when the card is added via the
  // Lovelace UI card picker, instead of an empty/invalid config.
  static getStubConfig() {
    return {
      type: 'custom:lens-navbar-card-dev',
      hide_labels: false,
      routes: [
        { icon: 'mdi:home', label: 'Home', tap_action: { action: 'navigate', navigation_path: '/lovelace/0' } },
        { icon: 'mdi:lightbulb-group', label: 'Lights', tap_action: { action: 'navigate', navigation_path: '#lights-popup' } },
        { icon: 'mdi:thermometer', label: 'Climate', tap_action: { action: 'navigate', navigation_path: '#climate-popup' } },
        { icon: 'mdi:cog', label: 'Settings', tap_action: { action: 'navigate', navigation_path: '/config/dashboard' } },
      ],
    };
  }

  // Built-in HA form editor for the card-level sizing options. `routes`
  // stays YAML-only - each route can carry a tap_action object, JS
  // templates for icon/icon_color/value_color/pulse, a value_entity, and
  // a dots array, which doesn't map cleanly onto ha-form's selector
  // types. This form covers the options that fix "icons too close
  // together" (the most reported pain point) plus the bar's max width,
  // so most users never need to leave the visual editor to get those fixed.
  static getConfigForm() {
    return {
      schema: [
        { name: 'hide_labels', selector: { boolean: {} } },
        { name: 'release_only', selector: { boolean: {} } },
        { name: 'haptic_enabled', selector: { boolean: {} } },
        {
          name: 'haptic_intensity',
          selector: { number: { min: 0, max: 50, step: 1, mode: 'slider', unit_of_measurement: 'ms' } },
        },
        {
          type: 'grid',
          name: '',
          schema: [
            {
              name: 'icon_size',
              selector: { number: { min: 16, max: 40, step: 1, mode: 'slider', unit_of_measurement: 'px' } },
            },
            {
              name: 'item_gap',
              selector: { number: { min: 0, max: 24, step: 1, mode: 'slider', unit_of_measurement: 'px' } },
            },
            {
              name: 'button_size',
              selector: { number: { min: 36, max: 72, step: 1, mode: 'slider', unit_of_measurement: 'px' } },
            },
            {
              name: 'lens_width',
              selector: { number: { min: 40, max: 120, step: 1, mode: 'slider', unit_of_measurement: 'px' } },
            },
            {
              name: 'max_width',
              selector: { number: { min: 200, max: 900, step: 10, mode: 'slider', unit_of_measurement: 'px' } },
            },
            {
              name: 'hover_delay',
              selector: { number: { min: 0, max: 400, step: 10, mode: 'slider', unit_of_measurement: 'ms' } },
            },
          ],
        },
      ],
      computeLabel: (schema) => {
        switch (schema.name) {
          case 'hide_labels':
            return 'Hide labels';
          case 'release_only':
            return 'Only navigate on release';
          case 'haptic_enabled':
            return 'Haptic feedback';
          case 'haptic_intensity':
            return 'Haptic intensity';
          case 'icon_size':
            return 'Icon size';
          case 'item_gap':
            return 'Gap between icons';
          case 'button_size':
            return 'Tap target size';
          case 'lens_width':
            return 'Lens width';
          case 'max_width':
            return 'Max bar width';
          case 'hover_delay':
            return 'Popup delay';
        }
        return undefined;
      },
      computeHelper: (schema) => {
        switch (schema.name) {
          case 'item_gap':
            return 'Raise this if icons are hard to hit accurately (default: 4px)';
          case 'button_size':
            return 'Width/height of each tap target (default: 54px)';
          case 'lens_width':
            return 'Leave empty to auto-size from tap target + gap. Set explicitly for a more pill-shaped lens.';
          case 'icon_size':
            return 'Default: 24px';
          case 'max_width':
            return 'Leave empty to fill the screen width. If routes overflow this, the bar scrolls horizontally - drag the lens to the edge to keep scrolling.';
          case 'hover_delay':
            return 'How long the lens must sit on an icon before its popup loads (default: 130ms). Higher = smoother fast swipes, lower = snappier. Ignored if "Only navigate on release" is on.';
          case 'release_only':
            return 'Popups never open mid-drag, only when you lift your finger off an icon. Overrides the popup delay above.';
          case 'haptic_enabled':
            return 'Vibrate/tap-feedback while dragging over icons and on tap (default: on). Turning this off also stops the Companion App\'s native haptic on iOS, not just the web Vibration API.';
          case 'haptic_intensity':
            return 'Vibration strength in ms (default: 8ms). Only affects navigator.vibrate, which Android/Chrome supports - iOS has no web Vibration API at all, so this slider has no effect there. Use the toggle above to control iOS haptics.';
        }
        return undefined;
      },
    };
  }

  set hass(hass) {
    this._hass = hass;
    // Theme switch (new themes object, other theme or dark mode): the
    // theme's --lg-look may have changed. Only then - never per tick.
    const th = hass && hass.themes;
    if (th !== this._themesRef || th?.theme !== this._themeName || th?.darkMode !== this._darkMode) {
      this._themesRef = th;
      this._themeName = th?.theme;
      this._darkMode = th?.darkMode;
      this._recheckThemeLook();
    }
    this._refreshVisibility();
    if (this._peekVisible) this._fillPeek();
    this._updateIconColors();
    this._updateValues();
    this._updateEditMode();
  }

  getCardSize() {
    return 1;
  }

  // Home Assistant's edit-mode wrapper (hui-card) exposes an `editMode`
  // property. This card is `position: fixed` for the live dashboard, which
  // leaves nothing visible inside the card's own box in the dashboard editor
  // (the real content floats elsewhere on screen) - so in edit mode it's
  // rendered in normal document flow instead, giving the editor real,
  // visible content to display and select.
  connectedCallback() {
    if (!this._onThemeChanged) this._onThemeChanged = () => this._checkThemeLook();
    window.addEventListener('lg-theme-changed', this._onThemeChanged);
    this._recheckThemeLook();
    this._updateEditMode();
    if (this._rendered) this._attachNavListeners();
    // HA may detach/re-attach the card when switching views; the URL can
    // have changed in between, so re-pick the mode that matches it.
    this._syncModeToLocation();
    this._updateActiveRoute();
  }

  // ---- look from the theme ---------------------------------------------
  // The navbar has no `look` option: with `--lg-look: solid` in the theme
  // (theme YAML `lg-look: solid`) the bar gets the solid look via the class
  // `lln-solid` on .lln-wrap. `--lln-bar-*` only override single properties
  // and never decide the look. Read on
  // connect (plus one frame later, themes can apply after that), on a
  // hass.themes change and on the window event `lg-theme-changed`.
  // v2.0.0: `--pane-effects` (glass | none) decides first; the older
  // `--lg-look: solid` still works when it is not set.
  _readThemeLook() {
    try {
      const cs = getComputedStyle(this);
      const read = (n) => cs.getPropertyValue(n).trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
      const fx = read('--pane-effects');
      if (fx === 'none' || fx === 'flat') return true;
      if (fx === 'glass') return false;
      return read('--lg-look') === 'solid';
    } catch (e) {
      return false;
    }
  }

  _recheckThemeLook() {
    this._checkThemeLook();
    if (typeof requestAnimationFrame !== 'function' || this._lookRaf) return;
    this._lookRaf = requestAnimationFrame(() => {
      this._lookRaf = null;
      this._checkThemeLook();
    });
  }

  _checkThemeLook() {
    if (!this.isConnected) return;
    const solid = this._readThemeLook();
    if (solid === !!this._solidLook) return;
    this._solidLook = solid;
    const wrap = this.querySelector('.lln-wrap');
    if (wrap) wrap.classList.toggle('lln-solid', solid);
  }

  // Element.closest() does not cross shadow-DOM boundaries, but Home
  // Assistant's card editor (and its live preview) nests this card several
  // shadow roots deep. Walk up via parentElement and, once we run out,
  // hop to the enclosing shadow root's host - this is the standard trick
  // for a "closest that crosses shadow boundaries".
  _closestAcrossShadow(selector) {
    let node = this;
    while (node) {
      if (node instanceof Element && node.matches && node.matches(selector)) return node;
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    return null;
  }

  _updateEditMode() {
    if (!this._rendered) return;
    const huiCard = this._closestAcrossShadow('hui-card');
    // Any of these ancestors means we're inside the card picker/editor
    // (including its live preview), not the real live dashboard - most
    // importantly `ha-dialog`, since the editor dialog applies a CSS
    // transform for its open/close animation, which turns it into the
    // containing block for `position: fixed` descendants. Without this
    // check the bar renders pinned to the *dialog's* edge instead of the
    // screen's, landing on top of (and swallowing taps on) the dialog's
    // own Save/Cancel buttons.
    const editMode =
      !!(huiCard && huiCard.editMode) ||
      !!this._closestAcrossShadow('hui-card-edit-mode') ||
      !!this._closestAcrossShadow('hui-dialog-edit-card') ||
      !!this._closestAcrossShadow('hui-card-preview') ||
      !!this._closestAcrossShadow('ha-dialog') ||
      !!this._closestAcrossShadow('[preview]');
    const wrap = this.querySelector('.lln-wrap');
    if (wrap) wrap.classList.toggle('lln-editmode', editMode);
  }

  // Re-evaluates each route's icon template/icon_color template, each
  // dot's color template, and the optional pulse template, against the
  // latest hass state, and applies the results. The icon itself (not
  // just its color) can be a JS template too - e.g. picking a weather
  // icon based on a weather entity's condition.
  _updateIconColors() {
    if (!this._hass || !this._rendered || !this.config) return;
    this._routes().forEach((route, i) => {
      const btn = this.querySelector(`.lln-btn[data-index="${i}"]`);
      if (route.icon) {
        const iconEl = btn && btn.querySelector('ha-icon');
        if (iconEl) {
          const resolvedIcon = this._evalTemplate(route.icon);
          if (resolvedIcon) iconEl.setAttribute('icon', resolvedIcon);
        }
      }
      if (route.icon_color) {
        const icon = btn && btn.querySelector('ha-icon');
        if (icon) {
          const color = this._evalTemplate(route.icon_color);
          icon.style.color = color || '';
        }
      }
      if (route.pulse && btn) {
        const shouldPulse = this._evalTemplate(route.pulse);
        btn.classList.toggle('lln-pulsing', !!shouldPulse);
      } else if (btn) {
        btn.classList.remove('lln-pulsing');
      }
      if (Array.isArray(route.dots)) {
        route.dots.forEach((dot, j) => {
          const dotEl = this.querySelector(`.lln-btn[data-index="${i}"] .lln-dot[data-dot="${j}"]`);
          if (!dotEl || !dot || !dot.color) return;
          const color = this._evalTemplate(dot.color);
          if (color) {
            dotEl.style.background = color;
            dotEl.style.boxShadow = `0 0 4px ${color}`;
          } else {
            dotEl.style.background = 'rgba(128, 128, 128, 0.35)';
            dotEl.style.boxShadow = 'none';
          }
        });
      }
    });
    this._updateModeDots();
  }

  // Mode dots: the active mode's dot is a wider pill; a *hidden* mode's
  // dot takes the first truthy `dots[].color` of that mode's routes, so
  // e.g. a red "server down" dot in the Tech mode stays visible while
  // the Home mode is showing. Only routes visible to this user count, so
  // a hidden admin route can't light up a dot for someone else.
  _updateModeDots() {
    if (!this._hass || !this._view || this._view.length < 2) return;
    this._view.forEach((mode, mi) => {
      const el = this.querySelector(`.lln-mdot[data-mode="${mi}"]`);
      if (!el) return;
      let alert = null;
      if (mi !== this._modeIndex) {
        for (const route of mode.routes) {
          for (const dot of route.dots || []) {
            const color = dot && dot.color ? this._evalTemplate(dot.color) : null;
            if (color) {
              alert = color;
              break;
            }
          }
          if (alert) break;
        }
      }
      el.style.background = alert || '';
      el.style.boxShadow = alert ? `0 0 4px ${alert}` : '';
    });
  }

  // Renders a small live text readout under an icon, driven by an
  // entity's current state - e.g. showing current solar production
  // wattage next to a Solar icon, the same way a dashboard badge would.
  // Optional `value_color` on the route follows the same plain-string-or-
  // [[[ template ]]] convention as icon_color/dots[].color, so the text
  // itself can be recolored based on the value (e.g. black at 0, a color
  // once it's above a threshold).
  _updateValues() {
    if (!this._hass || !this._rendered || !this.config) return;
    this._routes().forEach((route, i) => {
      if (!route.value_entity) return;
      const el = this.querySelector(`.lln-value[data-index="${i}"]`);
      if (!el) return;
      const st = this._hass.states[route.value_entity];
      if (!st) {
        el.textContent = '';
        return;
      }
      el.textContent = this._formatValue(st);
      if (route.value_color) {
        const color = this._evalTemplate(route.value_color);
        el.style.color = color || '';
      } else {
        el.style.color = '';
      }
    });
  }

  // Displays the entity's state the way HA's own UI would (e.g. "Ein"/
  // "Aus" instead of "on"/"off" under a German locale), by delegating to
  // the frontend's own state-formatter, which already knows the user's
  // language, the entity's device class, and any custom translations.
  // Falls back to the raw state + unit on older cores that don't expose
  // this helper on `hass` yet (added HA 2024.9), so this never throws.
  _formatValue(stateObj) {
    if (typeof this._hass.formatEntityState === 'function') {
      try {
        return this._hass.formatEntityState(stateObj);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('lens-navbar-card-dev: formatEntityState failed, falling back to raw state', err);
      }
    }
    const unit = stateObj.attributes && stateObj.attributes.unit_of_measurement ? stateObj.attributes.unit_of_measurement : '';
    return unit ? `${stateObj.state} ${unit}` : stateObj.state;
  }

  // Supports two forms for icon / icon_color / value_color / pulse / dot
  // color:
  //   - a plain string, e.g. "mdi:lightbulb" or "#FFD700"
  //   - a JS template wrapped in [[[ ... ]]], evaluated with `states`
  //     (an object keyed by entity_id, mirroring hass.states) and
  //     `hass` in scope. Must `return` a string (an mdi icon name or a
  //     CSS color, depending on the field), a boolean (for `pulse`), or
  //     null/undefined.
  //     Example: "[[[ return states['light.x'].state === 'on' ? '#FFD700' : null; ]]]"
  //     Example (pulse): "[[[ return states['alarm_control_panel.home'].state === 'triggered'; ]]]"
  //
  // Compiled functions are cached per template source string on the card
  // instance, so a template is only ever passed through `new Function(...)`
  // once no matter how many routes/dots reuse the same expression or how
  // many hass updates come through afterward - `set hass` (and therefore
  // this) fires on every state change anywhere in Home Assistant, so
  // avoiding a recompile on each of those calls is what keeps this cheap
  // as the number of templated routes grows.
  _evalTemplate(template) {
    const match = /^\s*\[\[\[([\s\S]*)\]\]\]\s*$/.exec(template);
    if (!match) return template;
    if (!this._templateFnCache) this._templateFnCache = new Map();
    let fn = this._templateFnCache.get(template);
    if (fn === undefined) {
      try {
        // eslint-disable-next-line no-new-func
        fn = new Function('states', 'hass', match[1]);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('lens-navbar-card-dev: template compile error', err);
        fn = null;
      }
      this._templateFnCache.set(template, fn);
    }
    if (!fn) return null;
    try {
      return fn(this._hass.states, this._hass);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('lens-navbar-card-dev: template error', err);
      return null;
    }
  }


  // Templated icons can't be resolved until `hass` is available, which
  // may be a beat after the first render. Show a neutral placeholder
  // instead of literally printing the "[[[ ... ]]]" template string as
  // the icon name; _updateIconColors() swaps in the real icon as soon
  // as hass arrives (it's already called at the end of every _render()
  // and on every `set hass`).
  _initialIcon(route) {
    return /^\s*\[\[\[/.test(route.icon || '') ? 'mdi:help-circle-outline' : route.icon;
  }

  // Whether a route's navigate target matches the current location -
  // hash-based popups compare against location.hash, plain view
  // navigation compares against the pathname (also matching sub-paths,
  // so a view path stays "active" while a hash popup is open on top of it).
  _isRouteActive(route) {
    const action = route.tap_action;
    if (!action || action.action !== 'navigate' || !action.navigation_path) return false;
    const path = action.navigation_path;
    if (path.startsWith('#')) return window.location.hash === path;
    // "/view#popup" style targets: don't let the view part alone mark
    // the route active, or every route on that view would light up.
    if (path.includes('#')) return false;
    return window.location.pathname === path || window.location.pathname.startsWith(`${path}/`);
  }

  // Moves the single "active" pill under the route that matches the
  // current location (sliding with a slight overshoot), and colors that
  // route's icon. If no route of the visible mode is active, the pill
  // fades out where it is.
  _updateActiveRoute() {
    if (!this._rendered || !this.config) return;
    let activeBtn = null;
    this._routes().forEach((route, i) => {
      const btn = this.querySelector(`.lln-btn[data-index="${i}"]`);
      if (!btn) return;
      const active = this._isRouteActive(route);
      btn.classList.toggle('lln-btn-active', active);
      if (active && !activeBtn) activeBtn = btn;
    });
    const pill = this.querySelector('.lln-pill');
    if (!pill) return;
    if (!activeBtn) {
      pill.classList.remove('lln-pill-on');
      return;
    }
    const x = activeBtn.offsetLeft;
    if (!pill.classList.contains('lln-pill-on')) {
      // Appearing: jump into place without sliding in from the last spot.
      pill.style.transition = 'none';
      pill.style.transform = `translateX(${x}px)`;
      void pill.offsetWidth;
      pill.style.transition = '';
      pill.classList.add('lln-pill-on');
    } else {
      pill.style.transform = `translateX(${x}px)`;
    }
  }

  // ---- visibility -----------------------------------------------------

  // Called from setConfig: works out which entities the conditions read
  // (so hass updates can be skipped cheaply), and builds the first view.
  _initVisibility() {
    const deps = new Set();
    let any = false;
    const collect = (vis) => {
      if (vis == null) return;
      any = true;
      this._collectConditionDeps(vis, deps);
    };
    this._modes.forEach((mode) => {
      collect(mode.visibility);
      mode.routes.forEach((route) => collect(route.visibility));
    });
    this._hasVisibility = any;
    this._visDeps = Array.from(deps);
    this._visSnap = null;
    this._visDirty = false;
    this._view = this._computeView();
    this._viewKey = this._keyOfView(this._view);
  }

  // Every entity id a condition list may read: `entity`/`entity_id`,
  // plus state/state_not/above/below values that name an entity (Lovelace
  // allows comparing against another entity's state there).
  _collectConditionDeps(conds, deps) {
    const list = Array.isArray(conds) ? conds : [conds];
    const addIfEntity = (v) => {
      (Array.isArray(v) ? v : [v]).forEach((x) => {
        if (typeof x === 'string' && LLN_ENTITY_ID.test(x)) deps.add(x);
      });
    };
    list.forEach((c) => {
      if (!c || typeof c !== 'object') return;
      if (c.conditions) this._collectConditionDeps(c.conditions, deps);
      addIfEntity(c.entity_id);
      addIfEntity(c.entity);
      addIfEntity(c.state);
      addIfEntity(c.state_not);
      addIfEntity(c.above);
      addIfEntity(c.below);
    });
  }

  // `set hass` fires on every state change anywhere in Home Assistant.
  // The conditions only depend on the user and a handful of entities, and
  // HA replaces a state object whenever that entity changes - so a cheap
  // identity check against the last seen objects tells us whether
  // re-evaluating could change anything at all.
  _visDepsChanged() {
    const hass = this._hass;
    const user = hass && hass.user ? hass.user.id : null;
    const states = this._visDeps.map((e) => (hass && hass.states ? hass.states[e] : undefined));
    const snap = this._visSnap;
    const changed =
      !snap || snap.user !== user || snap.states.length !== states.length || states.some((s, i) => s !== snap.states[i]);
    if (changed) this._visSnap = { user, states };
    return changed;
  }

  // Re-checks the conditions after a hass update and rebuilds the bar only
  // if the set of visible routes/modes actually differs. Mid-drag the
  // rebuild is postponed to the release: button indices must not shift
  // under the finger (the pending hover navigation refers to them).
  _refreshVisibility() {
    if (!this._hasVisibility || !this._modes) return;
    const changed = this._visDepsChanged();
    if (!changed && !this._visDirty) return;
    if (this._dragging) {
      this._visDirty = true;
      return;
    }
    this._visDirty = false;
    const view = this._computeView();
    const key = this._keyOfView(view);
    if (key === this._viewKey) return;
    this._applyView(view, key);
  }

  // The visible part of the config: modes whose own conditions pass and
  // that still have at least one visible route (an empty mode would be a
  // blank bar to swipe through). `src`/`ids` remember the config indices,
  // only used to tell whether two views are the same.
  _computeView() {
    const view = [];
    this._modes.forEach((mode, src) => {
      if (!this._isVisible(mode.visibility)) return;
      const routes = [];
      const ids = [];
      mode.routes.forEach((route, ri) => {
        if (!this._isVisible(route.visibility)) return;
        routes.push(route);
        ids.push(ri);
      });
      if (routes.length) view.push({ name: mode.name, path: mode.path, routes, src, ids });
    });
    return view;
  }

  _keyOfView(view) {
    return view.map((m) => `${m.src}:${m.ids.join(',')}`).join('|');
  }

  // Swaps in a new view and rebuilds only the buttons and mode dots - the
  // bar itself, its listeners and the lens stay. The mode the user is
  // looking at is kept if it is still visible: a state change must not
  // yank them back to the mode the URL belongs to after they swiped away.
  // The URL only decides when its mode has just become visible (typically
  // the first hass update revealing an admin mode the page was opened in)
  // or when the current mode disappeared.
  _applyView(view, key) {
    const oldView = this._view || [];
    const current = oldView[this._modeIndex];
    this._view = view;
    this._viewKey = key;
    const kept = current ? view.findIndex((m) => m.src === current.src) : -1;
    const loc = this._modeForLocation();
    const locIsNew = loc != null && !oldView.some((m) => m.src === view[loc].src);
    if (locIsNew || kept < 0) this._modeIndex = loc ?? 0;
    else this._modeIndex = kept;
    if (!this._rendered) return;
    this._hidePeek();
    this._renderModeDots();
    this._renderButtons(null);
    this._updateIconColors();
    this._updateValues();
    this._updateActiveRoute();
  }

  // Lovelace semantics: a list means "all must pass". Without hass the
  // user and states are unknown, so anything with conditions stays hidden
  // until the first update - better than flashing admin routes to everyone.
  _isVisible(conds) {
    if (conds == null) return true;
    if (!this._hass) return false;
    const list = Array.isArray(conds) ? conds : [conds];
    return list.every((c) => this._checkCondition(c));
  }

  // Mirrors Home Assistant's frontend (validate-condition.ts) for the
  // condition types that make sense on a navbar, including its quirks:
  // `not` is "not all of", a missing entity reads as "unknown", and a
  // state/above/below value may name another entity.
  _checkCondition(c) {
    if (!c || typeof c !== 'object') return true;
    const hass = this._hass;
    const type = c.condition ?? 'state';
    const entityState = (id) => (typeof id === 'string' && hass.states[id] ? hass.states[id].state : undefined);
    switch (type) {
      case 'user':
        return Array.isArray(c.users) && !!(hass.user && hass.user.id) && c.users.includes(hass.user.id);
      case 'and':
        return !c.conditions || this._isVisible(c.conditions);
      case 'or':
        return !c.conditions || (Array.isArray(c.conditions) ? c.conditions : [c.conditions]).some((x) => this._isVisible([x]));
      case 'not':
        return !c.conditions || !this._isVisible(c.conditions);
      case 'state': {
        const id = c.entity_id || c.entity;
        const st = id ? hass.states[id] : undefined;
        let state;
        if (!st) state = 'unknown';
        else if (c.attribute) state = st.attributes[c.attribute] == null ? 'unknown' : String(st.attributes[c.attribute]);
        else state = st.state;
        const wanted = c.state ?? c.state_not;
        if (wanted === undefined) return false;
        const values = [];
        (Array.isArray(wanted) ? wanted : [wanted]).forEach((v) => {
          values.push(String(v));
          const other = LLN_ENTITY_ID.test(String(v)) ? entityState(v) : undefined;
          if (other !== undefined) values.push(other);
        });
        return c.state != null ? values.includes(state) : !values.includes(state);
      }
      case 'numeric_state': {
        const id = c.entity_id || c.entity;
        const st = id ? hass.states[id] : undefined;
        const value = Number(c.attribute ? st && st.attributes[c.attribute] : st && st.state);
        if (!st || Number.isNaN(value)) return false;
        const limit = (v) => Number(entityState(v) ?? v);
        const above = limit(c.above);
        const below = limit(c.below);
        return (
          (c.above == null || Number.isNaN(above) || value > above) &&
          (c.below == null || Number.isNaN(below) || value < below)
        );
      }
      default:
        if (!LLN_WARNED_CONDITIONS.has(type)) {
          LLN_WARNED_CONDITIONS.add(type);
          // eslint-disable-next-line no-console
          console.warn(`lens-navbar-card-dev: visibility condition "${type}" is not supported, treating it as visible`);
        }
        return true;
    }
  }

  // ---- modes ----------------------------------------------------------

  _reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // Which mode the current URL belongs to: a mode's own `path` (view)
  // wins, otherwise the first mode containing a route that is active.
  // null = the URL doesn't say, keep whatever mode is showing. Only
  // visible modes/routes are considered: a URL that belongs to a hidden
  // route leaves the mode alone and simply highlights nothing.
  _modeForLocation() {
    if (!this._view || this._view.length < 2) return null;
    const pathname = window.location.pathname;
    const byPath = this._view.findIndex(
      (m) => m.path && (pathname === m.path || pathname.startsWith(`${m.path}/`))
    );
    if (byPath >= 0) return byPath;
    const byRoute = this._view.findIndex((m) => m.routes.some((r) => this._isRouteActive(r)));
    return byRoute >= 0 ? byRoute : null;
  }

  _syncModeToLocation() {
    if (!this._view || !this._rendered) return;
    const idx = this._modeForLocation();
    if (idx != null && idx !== this._modeIndex) {
      this._switchMode(idx, idx > this._modeIndex ? 'up' : 'down', false);
    }
  }

  // Switches to mode `idx` (wrapping around). The outgoing icons leave
  // in the swipe direction, the incoming ones arrive staggered from the
  // opposite side, and the glass bar morphs its width between the two
  // route counts instead of jumping.
  _switchMode(idx, dir, navigate) {
    const count = this._view.length;
    if (count < 2) return;
    idx = ((idx % count) + count) % count;
    if (idx === this._modeIndex) return;

    const scrollEl = this.querySelector('#lln-scroll');
    const bar = this.querySelector('#lln-bar');
    const animate = !!(scrollEl && bar) && !this._reducedMotion();
    const oldWidth = scrollEl ? scrollEl.offsetWidth : 0;

    // Outgoing icons: moved (not cloned) into a pointer-transparent ghost
    // row centered over the bar, animated out, then dropped.
    if (animate) {
      const oldButtons = Array.from(bar.querySelectorAll('.lln-btn'));
      if (oldButtons.length) {
        const ghost = document.createElement('div');
        ghost.className = 'lln-ghost';
        oldButtons.forEach((btn) => {
          btn.classList.remove('lln-in-up', 'lln-in-down', 'lln-btn-active');
          btn.classList.add(dir === 'up' ? 'lln-out-up' : 'lln-out-down');
          btn.removeAttribute('data-index');
          btn.querySelectorAll('[data-index]').forEach((el) => el.removeAttribute('data-index'));
          ghost.appendChild(btn);
        });
        bar.appendChild(ghost);
        setTimeout(() => ghost.remove(), 260);
      }
    }

    this._modeIndex = idx;
    this._renderButtons(animate ? dir : null);
    this._updateIconColors();
    this._updateValues();
    this._updateActiveRoute();
    this._flashModeLabel(this._view[idx].name);

    // FLIP the bar width: pin the old width, then let it spring to the
    // new one. The icon row is offset by half the difference and eased
    // back to 0 on the same curve, so the icons (and the outgoing ghost
    // row) stay centered while the glass grows or shrinks around them.
    if (animate) {
      const newWidth = scrollEl.offsetWidth;
      if (Math.abs(newWidth - oldWidth) > 1) {
        clearTimeout(this._morphTimer);
        scrollEl.classList.remove('lln-morph');
        scrollEl.style.width = `${oldWidth}px`;
        bar.style.transform = `translateX(${(oldWidth - newWidth) / 2}px)`;
        void scrollEl.offsetWidth;
        scrollEl.classList.add('lln-morph');
        scrollEl.style.width = `${newWidth}px`;
        bar.style.transform = '';
        this._morphTimer = setTimeout(() => {
          scrollEl.classList.remove('lln-morph');
          scrollEl.style.width = '';
        }, 420);
      }
    }

    if (this.config.haptic_enabled !== false) {
      this.dispatchEvent(new CustomEvent('haptic', { bubbles: true, composed: true, detail: 'medium' }));
      const intensity = this.config.haptic_intensity ?? 8;
      if (window.navigator && window.navigator.vibrate && intensity > 0) window.navigator.vibrate(intensity * 2);
    }

    const mode = this._view[idx];
    if (navigate && mode.path && window.location.pathname !== mode.path) {
      this._navigate(mode.path);
    }
  }

  // Shows the mode-name toast above the bar. `sticky` keeps it up (used
  // while a swipe is past the switch threshold, as a preview of where
  // releasing will go); otherwise it hides itself after ~1.1s.
  _flashModeLabel(text, sticky) {
    const label = this.querySelector('.lln-modelabel');
    if (!label) return;
    clearTimeout(this._labelTimer);
    if (!text) {
      label.classList.remove('lln-show');
      return;
    }
    label.textContent = text;
    label.classList.add('lln-show');
    if (!sticky) {
      this._labelTimer = setTimeout(() => label.classList.remove('lln-show'), 1100);
    }
  }

  // ---- peek (mini overview while dragging) ---------------------------

  // Shows the glass mini card above the bar for route `index` of the
  // current mode, with its caret pointing at that route's icon.
  _showPeek(index) {
    const peek = this.querySelector('.lln-peek');
    const route = this._routes()[index];
    if (!peek || !route || !route.peek) return;
    const wrap = this.querySelector('.lln-wrap');
    if (wrap && wrap.classList.contains('lln-editmode')) return;
    const changed = this._peekIndex !== index;
    this._peekIndex = index;
    this._fillPeek();
    const btn = this.querySelector(`.lln-btn[data-index="${index}"]`);
    if (btn) {
      const peekRect = peek.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      const x = btnRect.left + btnRect.width / 2 - peekRect.left;
      peek.style.setProperty('--lln-caret-x', `${Math.max(18, Math.min(peekRect.width - 18, x))}px`);
    }
    if (this._peekVisible && changed) {
      // Already open on another route: a quick content nudge instead of
      // closing and reopening the whole card.
      peek.classList.remove('lln-peek-swap');
      void peek.offsetWidth;
      peek.classList.add('lln-peek-swap');
    }
    this._flashModeLabel(null);
    peek.classList.add('lln-peek-on');
    this._peekVisible = true;
  }

  _hidePeek() {
    if (!this._peekVisible) return;
    const peek = this.querySelector('.lln-peek');
    if (peek) peek.classList.remove('lln-peek-on', 'lln-peek-swap');
    this._peekVisible = false;
    this._peekIndex = null;
  }

  // (Re)fills the visible peek from its route config - also on every
  // hass update while it is open, so values stay live.
  _fillPeek() {
    const peek = this.querySelector('.lln-peek');
    const route = this._peekIndex == null ? null : this._routes()[this._peekIndex];
    if (!peek || !route || !route.peek || !this._hass) return;
    const cfg = route.peek;
    const text = (v) => (v == null || v === false ? '' : String(this._evalTemplate(v) ?? ''));
    const iconEl = peek.querySelector('.lln-peek-icon');
    const icon = this._evalTemplate(cfg.icon || route.icon);
    if (icon) iconEl.setAttribute('icon', icon);
    iconEl.style.color = (route.icon_color && this._evalTemplate(route.icon_color)) || '';
    peek.querySelector('.lln-peek-title').textContent = text(cfg.title ?? route.label ?? '');
    peek.querySelector('.lln-peek-text').textContent = text(cfg.text);

    const bars = Array.isArray(cfg.bars) ? cfg.bars.slice(0, 4) : [];
    const barsEl = peek.querySelector('.lln-peek-bars');
    if (barsEl.childElementCount !== bars.length) {
      barsEl.innerHTML = bars
        .map(() => '<div class="lln-pbar"><span class="lln-pbar-label"></span><i><b></b></i></div>')
        .join('');
    }
    bars.forEach((bar, i) => {
      const el = barsEl.children[i];
      const max = Number(this._evalTemplate(bar.max ?? 100)) || 100;
      const value = Number(this._evalTemplate(bar.value));
      const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
      el.querySelector('.lln-pbar-label').textContent = text(bar.label);
      const fill = el.querySelector('b');
      fill.style.width = `${pct}%`;
      fill.style.background = (bar.color && this._evalTemplate(bar.color)) || '';
    });
    barsEl.style.display = bars.length ? '' : 'none';
  }

  // One dot per *visible* mode. The container exists whenever the config
  // has several modes, because visibility can change at runtime; with
  // fewer than two visible modes it is hidden, so the bar looks exactly
  // like a plain `routes` bar (no dots, and swiping is off as well).
  _renderModeDots() {
    const dots = this.querySelector('.lln-modes');
    if (!dots) return;
    const count = this._view.length;
    dots.style.display = count > 1 ? '' : 'none';
    if (dots.childElementCount !== count) {
      dots.innerHTML = this._view.map((_, mi) => `<span class="lln-mdot" data-mode="${mi}"></span>`).join('');
    }
  }

  _markActiveModeDot() {
    this.querySelectorAll('.lln-mdot').forEach((dot) => {
      dot.classList.toggle('lln-mdot-on', Number(dot.dataset.mode) === this._modeIndex);
    });
    this._updateModeDots();
  }

  _escape(value) {
    return String(value).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    );
  }

  // (Re)builds the buttons of the visible mode. `dir` ('up'/'down')
  // plays the staggered morph-in animation; the class is removed again
  // once it finished, so no animation stays attached to the buttons.
  _renderButtons(dir) {
    const bar = this.querySelector('#lln-bar');
    if (!bar) return;
    bar.querySelectorAll(':scope > .lln-btn').forEach((btn) => btn.remove());
    const html = this._routes()
      .map(
        (r, i) => `
          <button class="lln-btn${dir ? ` lln-in-${dir}` : ''}" data-index="${i}"
            aria-label="${this._escape(r.label || r.icon)}"${dir ? ` style="animation-delay:${i * 24}ms"` : ''}>
            <ha-icon icon="${this._escape(this._initialIcon(r))}"></ha-icon>
            ${r.label && !this.config.hide_labels ? `<span class="lln-label">${this._escape(r.label)}</span>` : ''}
            ${r.value_entity ? `<span class="lln-value" data-index="${i}"></span>` : ''}
            ${
              Array.isArray(r.dots)
                ? `<div class="lln-dots">${r.dots.map((_, j) => `<span class="lln-dot" data-dot="${j}"></span>`).join('')}</div>`
                : ''
            }
          </button>`
      )
      .join('');
    bar.querySelector('#lln-lens').insertAdjacentHTML('beforebegin', html);
    // Nothing visible for this user (or no hass yet and every route has
    // conditions): hide the whole bar instead of an empty glass pill.
    const wrap = this.querySelector('.lln-wrap');
    if (wrap) wrap.classList.toggle('lln-empty', this._routes().length === 0);
    if (dir) {
      bar.querySelectorAll(':scope > .lln-btn').forEach((btn) => {
        btn.addEventListener(
          'animationend',
          () => {
            btn.classList.remove('lln-in-up', 'lln-in-down');
            btn.style.animationDelay = '';
          },
          { once: true }
        );
      });
    }
    this._markActiveModeDot();
    const scrollEl = this.querySelector('#lln-scroll');
    if (scrollEl) scrollEl.scrollLeft = 0;
  }

  // ---- render ---------------------------------------------------------

  _render() {
    if (this._rendered) return;
    this._rendered = true;
    // A config change mid-drag replaces the bar and its listeners; the
    // old drag can never report its release, so don't wait for it.
    this._dragging = false;

    // Sizing knobs - all optional, all in px, and all default to the
    // card's original fixed values so existing configs render exactly
    // as before unless these are set explicitly.
    //   icon_size   - size of the ha-icon inside each button (default 24)
    //   item_gap    - gap between buttons in the bar (default 4)
    //   button_size - width/height of each tap target (default 54)
    //   lens_width  - width of the tracking lens; defaults to
    //                 button_size + item_gap * 2 so it keeps covering
    //                 one button's worth of space as those two change
    //   max_width   - max width of the visible bar "window". If the
    //                 routes overflow this, the window becomes
    //                 horizontally scrollable (default: fills the
    //                 screen minus a small margin, via calc(100vw - 32px))
    // Raising item_gap and/or button_size is the fix for icons sitting
    // too close together / being hard to hit accurately on narrow
    // screens or with many routes.
    const iconSize = this.config.icon_size ?? 24;
    const itemGap = this.config.item_gap ?? 4;
    const buttonSize = this.config.button_size ?? 54;
    const lensWidth = this.config.lens_width ?? buttonSize + itemGap * 2;
    const maxWidthCss = this.config.max_width ? `${this.config.max_width}px` : 'calc(100vw - 32px)';
    // Deliberately the *config's* mode count, not the visible one: the
    // dot row and label must already exist if visibility later reveals a
    // second mode. _renderModeDots() hides them while only one is visible.
    const multiMode = this._modes.length > 1;
    const hasPeek = this._modes.some((m) => m.routes.some((r) => r.peek));
    const spring = 'cubic-bezier(0.3, 1.3, 0.5, 1)';

    this.innerHTML = `
      <style>
        :host {
          display: block;
          min-height: 66px;
        }
        .lln-wrap {
          /* Card variables (--lln-*) win over the Pane family variables
             (--pane-*); unset both and the fixed defaults below apply. */
          --lln-x-bg: var(--lln-bar-bg, var(--pane-surface));
          --lln-x-backdrop: var(--lln-bar-backdrop, var(--pane-backdrop));
          --lln-x-border: var(--lln-bar-border, var(--pane-border));
          --lln-x-accent: var(--lln-accent, var(--pane-accent));
          position: fixed;
          bottom: 16px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 8;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .lln-wrap.lln-empty {
          display: none;
        }
        .lln-wrap.lln-editmode {
          position: relative;
          left: auto;
          bottom: auto;
          transform: none;
          justify-content: center;
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 16px;
        }
        .lln-scroll {
          position: relative;
          max-width: ${maxWidthCss};
          overflow-x: auto;
          overflow-y: hidden;
          overscroll-behavior-x: contain;
          scroll-behavior: auto;
          border-radius: 999px;
          background: var(--lln-x-bg, rgba(255, 255, 255, 0.02));
          backdrop-filter: var(--lln-x-backdrop, var(--lg-backdrop, blur(var(--pane-blur, 12px)) saturate(180%)));
          -webkit-backdrop-filter: var(--lln-x-backdrop, var(--lg-backdrop, blur(var(--pane-blur, 12px)) saturate(180%)));
          border: 1px solid var(--lln-x-border, rgba(255, 255, 255, 0.07));
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
          touch-action: none;
          -webkit-user-select: none;
          user-select: none;
          scrollbar-width: none;
          transition: transform 0.35s ${spring};
        }
        .lln-scroll::-webkit-scrollbar {
          display: none;
        }
        /* Theme look solid (--lg-look: solid): a calm solid bar like the
           solid Liquid Glass cards - no blur, a thin edge, the active route
           in the text colour. Explicit --lln-bar-* and --lln-accent
           variables still win. The lens rules follow the glass lens below. */
        .lln-wrap.lln-solid .lln-scroll {
          background: var(--lln-x-bg, var(--surface, color-mix(in srgb, var(--card-background-color, #1c1f28) 88%, transparent)));
          backdrop-filter: var(--lln-x-backdrop, none);
          -webkit-backdrop-filter: var(--lln-x-backdrop, none);
          border-color: var(--lln-x-border, rgba(255, 255, 255, 0.08));
        }
        .lln-wrap.lln-solid .lln-btn.lln-btn-active {
          color: var(--lln-x-accent, var(--primary-text-color));
        }
        .lln-wrap.lln-solid .lln-pill {
          background: color-mix(in srgb, var(--lln-x-accent, var(--primary-text-color, #fff)) 16%, transparent);
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lln-x-accent, var(--primary-text-color, #fff)) 22%, transparent);
        }
        /* Vertical swipe feedback: the bar follows the finger, rubber-band style. */
        .lln-scroll.lln-swiping {
          transform: translateY(var(--lln-pull, 0px));
          transition: none;
        }
        /* Mode switch: width morphs between the two route counts. */
        .lln-scroll.lln-morph {
          transition: transform 0.35s ${spring}, width 0.38s ${spring};
        }
        .lln-scroll.lln-morph .lln-bar {
          transition: transform 0.38s ${spring};
        }
        .lln-bar {
          position: relative;
          display: flex;
          gap: ${itemGap}px;
          padding: 8px 14px;
          width: max-content;
        }
        .lln-btn {
          all: unset;
          display: flex;
          flex: none;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          width: ${buttonSize}px;
          height: ${buttonSize}px;
          border-radius: 999px;
          color: var(--primary-text-color, rgba(255, 255, 255, 0.85));
          cursor: pointer;
          position: relative;
          z-index: 2;
          transition: background 0.15s ease, color 0.25s ease;
        }
        .lln-btn:active {
          background: rgba(255, 255, 255, 0.08);
        }
        .lln-btn.lln-btn-active {
          color: var(--lln-x-accent, var(--primary-color, #7c3aed));
        }
        .lln-btn ha-icon {
          --mdc-icon-size: ${iconSize}px;
        }
        .lln-btn.lln-pulsing ha-icon {
          animation: lln-pulse 1s ease-in-out infinite;
        }
        @keyframes lln-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.2); opacity: 0.7; }
        }
        /* One shared highlight that slides to the active route. */
        .lln-pill {
          position: absolute;
          top: 8px;
          left: 0;
          width: ${buttonSize}px;
          height: ${buttonSize}px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--lln-x-accent, var(--primary-color, #7c3aed)) 16%, transparent);
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lln-x-accent, var(--primary-color, #7c3aed)) 22%, transparent);
          opacity: 0;
          scale: 0.6;
          pointer-events: none;
          z-index: 1;
          transition: transform 0.42s ${spring}, opacity 0.2s ease, scale 0.3s ${spring};
        }
        .lln-pill.lln-pill-on {
          opacity: 1;
          scale: 1;
        }
        /* Mode switch: new icons morph in from the swipe direction ... */
        .lln-btn.lln-in-up {
          animation: lln-in-up 0.34s ${spring} both;
        }
        .lln-btn.lln-in-down {
          animation: lln-in-down 0.34s ${spring} both;
        }
        @keyframes lln-in-up {
          from { opacity: 0; transform: translateY(70%) scale(0.6); filter: blur(4px); }
          to { opacity: 1; transform: none; filter: none; }
        }
        @keyframes lln-in-down {
          from { opacity: 0; transform: translateY(-70%) scale(0.6); filter: blur(4px); }
          to { opacity: 1; transform: none; filter: none; }
        }
        /* ... while the old ones leave the other way (no blur: cheaper). */
        .lln-ghost {
          position: absolute;
          top: 0;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          gap: ${itemGap}px;
          padding: 8px 14px;
          width: max-content;
          pointer-events: none;
        }
        .lln-btn.lln-out-up {
          animation: lln-out-up 0.22s ease-in both;
        }
        .lln-btn.lln-out-down {
          animation: lln-out-down 0.22s ease-in both;
        }
        @keyframes lln-out-up {
          to { opacity: 0; transform: translateY(-60%) scale(0.7); }
        }
        @keyframes lln-out-down {
          to { opacity: 0; transform: translateY(60%) scale(0.7); }
        }
        .lln-label {
          font-size: 9px;
          margin-top: 2px;
          opacity: 0.8;
          white-space: nowrap;
        }
        .lln-value {
          margin-top: 1px;
          height: 5px;
          line-height: 5px;
          font-size: 8px;
          opacity: 0.85;
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
          pointer-events: none;
          overflow: visible;
        }
        .lln-dots {
          display: flex;
          gap: 3px;
          margin-top: 3px;
        }
        .lln-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: rgba(128, 128, 128, 0.35);
          transition: background 0.3s ease, box-shadow 0.3s ease;
        }
        /* The lens is positioned with transform (no layout per frame);
           its pop-in uses the separate "scale" property so the two don't
           fight. Position/squash are driven from JS every frame. */
        .lln-lens {
          position: absolute;
          top: 0;
          left: 0;
          width: ${lensWidth}px;
          height: 100%;
          border-radius: 999px;
          pointer-events: none;
          opacity: 0;
          scale: 0.85;
          transition: opacity 0.18s ease, scale 0.22s ${spring};
          will-change: transform;
          backdrop-filter: blur(2px) saturate(220%) brightness(1.35);
          -webkit-backdrop-filter: blur(2px) saturate(220%) brightness(1.35);
          background: radial-gradient(
            circle at 32% 26%,
            rgba(255, 255, 255, 0.28),
            rgba(255, 255, 255, 0.04) 45%,
            transparent 72%
          );
          box-shadow:
            inset 0 0 14px rgba(255, 255, 255, 0.22),
            inset 0 -8px 12px rgba(0, 0, 0, 0.12),
            inset 3px 0 8px rgba(80, 200, 255, 0.32),
            inset -3px 0 8px rgba(255, 90, 190, 0.3),
            inset 0 3px 6px rgba(255, 255, 255, 0.22),
            0 6px 18px rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.4);
          z-index: 3;
        }
        .lln-lens.active {
          opacity: 1;
          scale: 1;
        }
        /* On release the lens glides onto the chosen icon, then fades. */
        .lln-lens.lln-settle {
          transition: transform 0.26s ${spring}, opacity 0.22s ease 0.12s, scale 0.26s ease;
        }
        /* Solid look: the lens is an opaque flat pill of the active pill's
           family, raised a step - no blur, gloss or glass rim. It sits under
           the icons (z-index 1, after the pill) so they stay crisp. */
        .lln-wrap.lln-solid .lln-lens {
          top: 8px;
          height: ${buttonSize}px;
          z-index: 1;
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
          border: 0;
          background: color-mix(
            in srgb,
            var(--lln-x-accent, var(--primary-text-color, #fff)) 20%,
            var(--surface-solid, var(--card-background-color, #1c1f28))
          );
          box-shadow:
            inset 0 0 0 1px color-mix(in srgb, var(--lln-x-accent, var(--primary-text-color, #fff)) 28%, transparent),
            0 4px 14px rgba(0, 0, 0, 0.22);
        }
        .lln-wrap.lln-solid .lln-lens.active {
          scale: 1.04;
        }
        .lln-modes {
          display: flex;
          gap: 5px;
          margin-bottom: 6px;
          padding: 3px 7px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.04);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }
        .lln-mdot {
          width: 5px;
          height: 5px;
          border-radius: 999px;
          background: rgba(128, 128, 128, 0.45);
          transition: width 0.3s ${spring}, background 0.3s ease;
        }
        .lln-mdot.lln-mdot-on {
          width: 14px;
          background: var(--primary-text-color, rgba(255, 255, 255, 0.85)) !important;
          box-shadow: none !important;
        }
        .lln-modelabel {
          position: absolute;
          bottom: calc(100% + 4px);
          left: 50%;
          transform: translate(-50%, 6px) scale(0.92);
          opacity: 0;
          pointer-events: none;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.02em;
          padding: 4px 12px;
          border-radius: 999px;
          color: var(--primary-text-color, #fff);
          background: rgba(255, 255, 255, 0.08);
          backdrop-filter: blur(14px) saturate(180%);
          -webkit-backdrop-filter: blur(14px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.12);
          white-space: nowrap;
          transition: opacity 0.2s ease, transform 0.3s ${spring};
        }
        .lln-modelabel.lln-show {
          opacity: 1;
          transform: translate(-50%, 0) scale(1);
        }
        /* Peek: mini overview card above the bar while the lens rests on
           a route that has a \`peek\` config. */
        .lln-peek {
          position: absolute;
          bottom: calc(100% + 10px);
          left: 50%;
          width: min(320px, calc(100vw - 32px));
          box-sizing: border-box;
          padding: 12px 16px 14px;
          border-radius: 22px;
          color: var(--primary-text-color, #fff);
          /* Follows the theme's surface like the bar does (--lln-peek-bg wins). */
          background: var(--lln-peek-bg, var(--pane-surface, color-mix(in srgb, var(--card-background-color, #1c1f28) 72%, transparent)));
          backdrop-filter: var(--lln-x-backdrop, blur(22px) saturate(170%));
          -webkit-backdrop-filter: var(--lln-x-backdrop, blur(22px) saturate(170%));
          border: 1px solid var(--lln-x-border, rgba(255, 255, 255, 0.12));
          box-shadow: 0 18px 50px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08);
          opacity: 0;
          transform: translate(-50%, 14px) scale(0.94);
          transform-origin: var(--lln-caret-x, 50%) 100%;
          pointer-events: none;
          transition: opacity 0.18s ease, transform 0.34s ${spring};
        }
        .lln-peek.lln-peek-on {
          opacity: 1;
          transform: translate(-50%, 0) scale(1);
        }
        .lln-peek::after {
          content: '';
          position: absolute;
          bottom: -6px;
          left: var(--lln-caret-x, 50%);
          width: 11px;
          height: 11px;
          margin-left: -6px;
          transform: rotate(45deg);
          background: inherit;
          border-right: 1px solid var(--lln-x-border, rgba(255, 255, 255, 0.12));
          border-bottom: 1px solid var(--lln-x-border, rgba(255, 255, 255, 0.12));
          border-bottom-right-radius: 3px;
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
          transition: left 0.3s ${spring};
        }
        .lln-peek.lln-peek-swap .lln-peek-head,
        .lln-peek.lln-peek-swap .lln-peek-text {
          animation: lln-peek-swap 0.24s ease;
        }
        @keyframes lln-peek-swap {
          from { opacity: 0.2; transform: translateY(3px); }
          to { opacity: 1; transform: none; }
        }
        .lln-peek-head {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 15px;
          font-weight: 650;
          letter-spacing: -0.01em;
        }
        .lln-peek-icon {
          --mdc-icon-size: 20px;
          display: inline-flex;
        }
        .lln-peek-text {
          margin-top: 3px;
          font-size: 13px;
          line-height: 1.35;
          opacity: 0.72;
          white-space: pre-line;
        }
        .lln-peek-text:empty {
          display: none;
        }
        .lln-peek-bars {
          display: flex;
          gap: 8px;
          margin-top: 10px;
        }
        .lln-pbar {
          flex: 1;
          min-width: 0;
        }
        .lln-pbar-label {
          display: block;
          font-size: 10px;
          opacity: 0.6;
          margin-bottom: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .lln-pbar-label:empty {
          display: none;
        }
        .lln-pbar i {
          display: block;
          height: 7px;
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.12);
          overflow: hidden;
        }
        .lln-pbar b {
          display: block;
          height: 100%;
          border-radius: 6px;
          background: var(--primary-color, #7c3aed);
          transition: width 0.4s ${spring};
        }
        /* Solid look: mode dots, mode label and peek on the solid surface,
           without blur or glass sheen. */
        .lln-wrap.lln-solid .lln-modes {
          background: var(--lln-x-bg, var(--surface, color-mix(in srgb, var(--card-background-color, #1c1f28) 88%, transparent)));
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
        }
        .lln-wrap.lln-solid .lln-modelabel,
        .lln-wrap.lln-solid .lln-peek {
          background: var(--surface-solid, var(--card-background-color, #1c1f28));
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
          border-color: var(--lln-x-border, rgba(255, 255, 255, 0.08));
        }
        .lln-wrap.lln-solid .lln-peek {
          box-shadow: 0 18px 50px rgba(0, 0, 0, 0.4);
        }
        .lln-wrap.lln-solid .lln-peek::after {
          border-color: var(--lln-x-border, rgba(255, 255, 255, 0.08));
        }
        @media (prefers-reduced-motion: reduce) {
          .lln-btn.lln-in-up,
          .lln-btn.lln-in-down {
            animation: lln-fade 0.12s ease both;
          }
          @keyframes lln-fade {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          .lln-btn.lln-pulsing ha-icon {
            animation: none;
          }
          .lln-peek,
          .lln-pill,
          .lln-lens,
          .lln-lens.lln-settle,
          .lln-modelabel,
          .lln-scroll {
            transition: opacity 0.12s ease;
          }
        }
      </style>
      <div class="lln-wrap${this._solidLook ? ' lln-solid' : ''}">
        ${
          hasPeek
            ? `<div class="lln-peek" aria-hidden="true">
                 <div class="lln-peek-head"><ha-icon class="lln-peek-icon"></ha-icon><span class="lln-peek-title"></span></div>
                 <div class="lln-peek-text"></div>
                 <div class="lln-peek-bars"></div>
               </div>`
            : ''
        }
        ${
          multiMode
            ? `<div class="lln-modelabel"></div>
               <div class="lln-modes" aria-hidden="true"></div>`
            : ''
        }
        <div class="lln-scroll" id="lln-scroll">
          <div class="lln-bar" id="lln-bar">
            <div class="lln-pill"></div>
            <div class="lln-lens" id="lln-lens"></div>
          </div>
        </div>
      </div>
    `;
    this._renderModeDots();
    this._renderButtons(null);

    const scrollEl = this.querySelector('#lln-scroll');
    const bar = this.querySelector('#lln-bar');
    const lens = this.querySelector('#lln-lens');
    let dragging = false;
    let lastHoverIndex = null;
    let pointerX = 0;
    let pointerY = 0;
    let startX = 0;
    let startY = 0;
    let downAt = 0;
    let swiping = false;
    let swipeArmed = false;
    let rafId = null;
    // Lens physics: it eases toward the finger (instead of sticking to it
    // 1:1) and squashes a little with speed, like a drop of liquid.
    let lensX = null;
    let btnSpans = [];

    // How close (in px) to the visible edge of the scroll window before
    // auto-scroll kicks in, and the fastest it'll scroll (px/frame) once
    // the pointer is pinned right at the edge.
    const EDGE_ZONE = 36;
    const MAX_SCROLL_SPEED = 14;
    const SNAP_PADDING = 10;
    const VERTICAL_TOLERANCE_TOP = 90;
    const VERTICAL_TOLERANCE_BOTTOM = 40;
    // A plain tap shouldn't flash the lens: it only appears once the
    // finger moved a little or stayed down for a moment.
    const LENS_SHOW_DELAY_MS = 80;
    const LENS_SHOW_MOVE_PX = 4;
    // Mode swipe: how far (px) the finger must travel vertically before
    // the gesture counts as a mode swipe instead of a lens drag, and how
    // far it must travel for the release to actually switch modes.
    const SWIPE_DETECT = 14;
    const SWIPE_SWITCH = 28;
    const HOVER_DWELL_MS = this.config.hover_delay ?? 130;
    // A peek waits a moment so that sweeping across several icons doesn't
    // flash a card for each; once one is open, moving on updates it at once.
    const PEEK_DELAY_MS = this.config.peek_delay ?? 120;
    const RELEASE_ONLY = !!this.config.release_only;

    let pendingTimer = null;
    let pendingIndex = null;

    const clearPending = () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      pendingIndex = null;
    };

    // haptic_enabled / haptic_intensity: plain card config, editable in the
    // visual editor above. IMPORTANT: iOS Safari/WKWebView has no Vibration
    // API at all - what you actually feel on an iPhone comes from the
    // Companion App's native haptic bridge, which listens for the "haptic"
    // CustomEvent below, not from navigator.vibrate(). So the enabled check
    // has to gate that dispatchEvent call too, not just vibrate().
    const fireHaptic = () => {
      const hapticsEnabled = this.config.haptic_enabled !== false;
      if (!hapticsEnabled) return;
      this.dispatchEvent(new CustomEvent('haptic', { bubbles: true, composed: true, detail: 'selection' }));
      const intensity = this.config.haptic_intensity ?? 8;
      if (window.navigator && window.navigator.vibrate && intensity > 0) window.navigator.vibrate(intensity);
    };

    // Button positions relative to the bar. These don't change while
    // the bar scrolls (only the bar's own rect does), so they're read
    // once per drag instead of calling getBoundingClientRect() on every
    // button every frame.
    const measureButtons = () => {
      btnSpans = Array.from(bar.querySelectorAll(':scope > .lln-btn')).map((b) => [
        b.offsetLeft,
        b.offsetLeft + b.offsetWidth,
      ]);
    };

    // Haptic feedback still fires immediately on every icon the lens
    // crosses (cheap, feels responsive) - but the actual navigation
    // (which mounts/unmounts a popup) is debounced: it only fires once
    // the lens has sat on the same icon for HOVER_DWELL_MS without
    // moving to a different one. This is what stops a fast swipe from
    // rapidly loading/unloading every popup in between.
    const updateHoverIndex = (localX) => {
      let idx = null;
      for (let i = 0; i < btnSpans.length; i++) {
        if (localX >= btnSpans[i][0] && localX <= btnSpans[i][1]) {
          idx = i;
          break;
        }
      }
      if (idx !== lastHoverIndex) {
        lastHoverIndex = idx;
        clearPending();
        if (idx === null) {
          this._hidePeek();
        } else {
          fireHaptic();
          pendingIndex = idx;
          const hovered = this._routes()[idx];
          if (hovered && hovered.peek) {
            // Routes with a `peek` don't open their popup mid-drag: the
            // lens shows the mini overview instead, and releasing opens
            // the popup (pendingIndex stays set for stopDrag()).
            const showPeek = () => {
              const dy = Math.abs(pointerY - startY);
              if (this._view.length > 1 && dy > 4 && dy > Math.abs(pointerX - startX)) {
                pendingTimer = setTimeout(showPeek, 60);
                return;
              }
              pendingTimer = null;
              this._showPeek(idx);
            };
            pendingTimer = setTimeout(showPeek, this._peekVisible ? 0 : PEEK_DELAY_MS);
          } else if (!RELEASE_ONLY) {
            this._hidePeek();
            const fire = () => {
              // A slow start of a mode swipe (mostly vertical, not yet
              // past SWIPE_DETECT) must not open the popup under the
              // finger - wait until the gesture has made up its mind.
              const dy = Math.abs(pointerY - startY);
              if (this._view.length > 1 && dy > 4 && dy > Math.abs(pointerX - startX)) {
                pendingTimer = setTimeout(fire, 60);
                return;
              }
              pendingTimer = null;
              pendingIndex = null;
              const route = this._routes()[idx];
              if (route) this._handleAction(route);
            };
            pendingTimer = setTimeout(fire, HOVER_DWELL_MS);
          } else {
            this._hidePeek();
          }
        }
      }
    };

    // Nudges scrollEl.scrollLeft toward revealing more routes whenever the
    // pointer sits inside the edge zone, scaled by how deep into that zone
    // it is. No-ops once there's nothing left to reveal in that direction.
    const applyAutoScroll = (scrollRect) => {
      const maxScrollLeft = scrollEl.scrollWidth - scrollEl.clientWidth;
      if (maxScrollLeft <= 0) return;
      if (pointerX < scrollRect.left + EDGE_ZONE && scrollEl.scrollLeft > 0) {
        const depth = Math.min(1, (scrollRect.left + EDGE_ZONE - pointerX) / EDGE_ZONE);
        scrollEl.scrollLeft = Math.max(0, scrollEl.scrollLeft - depth * MAX_SCROLL_SPEED);
      } else if (pointerX > scrollRect.right - EDGE_ZONE && scrollEl.scrollLeft < maxScrollLeft) {
        const depth = Math.min(1, (pointerX - (scrollRect.right - EDGE_ZONE)) / EDGE_ZONE);
        scrollEl.scrollLeft = Math.min(maxScrollLeft, scrollEl.scrollLeft + depth * MAX_SCROLL_SPEED);
      }
    };

    // If the button the lens was last over is partially clipped by the
    // scroll window's edges when the drag ends, smooth-scroll just enough
    // to bring it fully into view instead of leaving it half-cut-off.
    const snapButtonIntoView = (index) => {
      if (index === null) return;
      const btn = bar.querySelectorAll(':scope > .lln-btn')[index];
      if (!btn) return;
      const scrollRect = scrollEl.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      let delta = 0;
      if (btnRect.left < scrollRect.left + SNAP_PADDING) {
        delta = btnRect.left - (scrollRect.left + SNAP_PADDING);
      } else if (btnRect.right > scrollRect.right - SNAP_PADDING) {
        delta = btnRect.right - (scrollRect.right - SNAP_PADDING);
      }
      if (delta !== 0) {
        scrollEl.scrollTo({ left: scrollEl.scrollLeft + delta, behavior: 'smooth' });
      }
    };

    // One rAF loop drives everything while dragging: auto-scroll, lens
    // movement, and hover/tap-action detection. Running this every
    // frame (not just on pointermove) is what makes the icons keep
    // scrolling under a finger that's stopped moving but is still pinned
    // at the edge - the bar's geometry shifts under a fixed clientX.
    const frameTick = () => {
      if (!dragging) return;
      const scrollRect = scrollEl.getBoundingClientRect();
      const tooFarVertically =
        pointerY < scrollRect.top - VERTICAL_TOLERANCE_TOP || pointerY > scrollRect.bottom + VERTICAL_TOLERANCE_BOTTOM;

      if (swiping || tooFarVertically) {
        lens.classList.remove('active');
        if (lastHoverIndex !== null) {
          // Sliding off the bar while peeking means "just looking":
          // releasing out there won't open the popup.
          if (this._peekVisible) clearPending();
          this._hidePeek();
        }
        lastHoverIndex = null;
        lensX = null;
      } else {
        applyAutoScroll(scrollRect);

        const barRect = bar.getBoundingClientRect();
        const lensSize = lens.offsetWidth;
        const minX = Math.max(scrollRect.left, barRect.left) + lensSize / 2;
        const maxX = Math.min(scrollRect.right, barRect.right) - lensSize / 2;
        const clampedX = Math.min(Math.max(pointerX, minX), maxX);
        const target = clampedX - barRect.left - lensSize / 2;

        const reduced = this._reducedMotion();
        const prev = lensX;
        lensX = lensX === null || reduced ? target : lensX + (target - lensX) * 0.35;
        const velocity = prev === null ? 0 : lensX - prev;
        // The solid lens is a flat pill: it glides, but doesn't squash.
        const squash = reduced || this._solidLook ? 0 : Math.min(Math.abs(velocity) * 0.012, 0.18);
        lens.style.transform = `translate3d(${lensX}px, 0, 0) scale(${1 + squash}, ${1 - squash * 0.6})`;

        const moved = Math.abs(pointerX - startX) > LENS_SHOW_MOVE_PX;
        if (moved || performance.now() - downAt > LENS_SHOW_DELAY_MS) lens.classList.add('active');

        updateHoverIndex(clampedX - barRect.left);
      }

      rafId = requestAnimationFrame(frameTick);
    };

    // On release over an icon the lens glides onto that icon's center
    // (instead of vanishing wherever the finger was) and fades out there.
    const settleLens = (index) => {
      const btn = index === null ? null : bar.querySelectorAll(':scope > .lln-btn')[index];
      if (btn && lens.classList.contains('active') && !this._reducedMotion()) {
        lens.classList.add('lln-settle');
        const x = btn.offsetLeft + btn.offsetWidth / 2 - lens.offsetWidth / 2;
        lens.style.transform = `translate3d(${x}px, 0, 0)`;
        clearTimeout(this._settleTimer);
        this._settleTimer = setTimeout(() => lens.classList.remove('lln-settle'), 380);
      }
      lens.classList.remove('active');
      lensX = null;
    };

    // A visibility change that arrived mid-drag was postponed (see
    // _refreshVisibility); apply it now that indices may shift again.
    const stopDrag = (cancelled) => {
      finishDrag(cancelled);
      this._dragging = false;
      if (this._visDirty) this._refreshVisibility();
    };

    const finishDrag = (cancelled) => {
      dragging = false;
      this._hidePeek();
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      const releasedIndex = lastHoverIndex;
      lastHoverIndex = null;
      document.removeEventListener('pointermove', onDocPointerMove);
      document.removeEventListener('pointerup', onDocPointerUp);
      document.removeEventListener('pointercancel', onDocPointerCancel);
      scrollEl.classList.remove('lln-swiping');
      scrollEl.style.removeProperty('--lln-pull');

      // A vertical swipe never navigates to a route - it switches the mode
      // (swipe up = next mode, swipe down = previous), or does nothing if
      // the finger came back before reaching the switch threshold.
      const wasSwipe = swiping;
      swiping = false;
      swipeArmed = false;
      if (wasSwipe) {
        lens.classList.remove('active');
        lensX = null;
        clearPending();
        const dy = pointerY - startY;
        if (!cancelled && Math.abs(dy) > SWIPE_SWITCH) {
          this._switchMode(this._modeIndex + (dy < 0 ? 1 : -1), dy < 0 ? 'up' : 'down', true);
        } else {
          this._flashModeLabel(null);
        }
        return;
      }

      settleLens(cancelled ? null : releasedIndex);

      // Releasing always navigates right away - in dwell mode this
      // finalizes early instead of waiting out the delay; in
      // release_only mode this is the *only* place navigation ever fires.
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      if (pendingIndex !== null && !cancelled) {
        const route = this._routes()[pendingIndex];
        if (route) this._handleAction(route);
      }
      pendingIndex = null;
      snapButtonIntoView(releasedIndex);
      this._updateActiveRoute();
    };

    const onDocPointerMove = (e) => {
      if (!dragging) return;
      pointerX = e.clientX;
      pointerY = e.clientY;
      if (this._view.length < 2) return;
      const dx = pointerX - startX;
      const dy = pointerY - startY;
      // Mostly-vertical movement past the threshold turns the drag into
      // a mode swipe: the lens hides and pending navigation is dropped.
      if (!swiping && Math.abs(dy) > SWIPE_DETECT && Math.abs(dy) > Math.abs(dx) * 1.3) {
        swiping = true;
        clearPending();
        scrollEl.classList.add('lln-swiping');
      }
      if (!swiping) return;
      // Rubber band: the bar follows the finger with growing resistance.
      scrollEl.style.setProperty('--lln-pull', `${(18 * Math.tanh(dy / 60)).toFixed(2)}px`);
      // Crossing the switch threshold ticks once and previews the
      // target mode's name; backing off hides the preview again.
      const armed = Math.abs(dy) > SWIPE_SWITCH;
      if (armed !== swipeArmed) {
        swipeArmed = armed;
        if (armed) {
          fireHaptic();
          const count = this._view.length;
          const target = (((this._modeIndex + (dy < 0 ? 1 : -1)) % count) + count) % count;
          this._flashModeLabel(this._view[target].name, true);
        } else {
          this._flashModeLabel(null);
        }
      }
    };
    const onDocPointerUp = () => stopDrag(false);
    const onDocPointerCancel = () => stopDrag(true);

    scrollEl.addEventListener('pointerdown', (e) => {
      dragging = true;
      this._dragging = true;
      swiping = false;
      swipeArmed = false;
      pointerX = startX = e.clientX;
      pointerY = startY = e.clientY;
      downAt = performance.now();
      lensX = null;
      lens.classList.remove('lln-settle');
      measureButtons();
      document.addEventListener('pointermove', onDocPointerMove);
      document.addEventListener('pointerup', onDocPointerUp);
      document.addEventListener('pointercancel', onDocPointerCancel);
      rafId = requestAnimationFrame(frameTick);
    });

    this._attachNavListeners();
    this._updateIconColors();
    this._updateValues();
    this._updateEditMode();
    this._updateActiveRoute();
    // Editor dialogs sometimes finish mounting their own wrapper a beat
    // after this card's connectedCallback has already fired, so the very
    // first _updateEditMode() call can miss the ha-dialog ancestor. One
    // cheap delayed re-check covers that race without needing a
    // MutationObserver. The pill is re-placed too, since button offsets
    // are only reliable once the card is actually laid out.
    setTimeout(() => {
      this._updateEditMode();
      this._updateActiveRoute();
    }, 50);
  }

  // Keeps the persistent "active route" highlight - and the active mode -
  // in sync with hash-based popup navigation, plain view navigation, and
  // browser back/forward. Attached while the card is in the DOM only.
  _attachNavListeners() {
    if (this._onNav) return;
    this._onNav = () => {
      this._syncModeToLocation();
      this._updateActiveRoute();
    };
    window.addEventListener('hashchange', this._onNav);
    window.addEventListener('location-changed', this._onNav);
    window.addEventListener('popstate', this._onNav);
  }

  _detachNavListeners() {
    if (!this._onNav) return;
    window.removeEventListener('hashchange', this._onNav);
    window.removeEventListener('location-changed', this._onNav);
    window.removeEventListener('popstate', this._onNav);
    this._onNav = null;
  }

  disconnectedCallback() {
    this._detachNavListeners();
    if (this._onThemeChanged) window.removeEventListener('lg-theme-changed', this._onThemeChanged);
    if (this._lookRaf) cancelAnimationFrame(this._lookRaf);
    this._lookRaf = null;
    clearTimeout(this._labelTimer);
    clearTimeout(this._morphTimer);
    clearTimeout(this._settleTimer);
  }

  // Navigates without a native `location.hash` assignment - on the iOS
  // Companion App's WKWebView that was observed to trigger a brief
  // reload/flash of the whole dashboard on every hash-based popup
  // navigation (not reproducible on Android or desktop browsers).
  // pushState changes the URL without that native-navigation signal;
  // hashchange is dispatched manually since pushState doesn't fire it on
  // its own, so Bubble Card and this card's own active-route detection
  // keep working unchanged. Fixed in v1.5.3.
  _navigate(path) {
    if (path.startsWith('#')) {
      const oldURL = window.location.href;
      window.history.pushState(null, '', path);
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
    } else {
      window.history.pushState(null, '', path);
      window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
    }
  }

  _handleAction(route) {
    const action = route.tap_action;
    if (!action) return;

    if (action.action === 'navigate') {
      if (action.navigation_path) this._navigate(action.navigation_path);
    } else if (action.action === 'call-service' || action.action === 'perform-action') {
      const [domain, service] = (action.service || action.perform_action).split('.');
      this._hass.callService(domain, service, action.service_data || action.data || {}, action.target || {});
    }

    if (this.config.haptic_enabled !== false) {
      this.dispatchEvent(new CustomEvent('haptic', { bubbles: true, composed: true, detail: 'light' }));
    }
  }
}

customElements.define('lens-navbar-card-dev', LensNavbarCard);
// The old card type keeps working (same card, own element name).
class LiquidLensNavbarCard extends LensNavbarCard {}
customElements.define('liquid-lens-navbar-card-dev', LiquidLensNavbarCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'lens-navbar-card-dev',
  name: 'Lens Navbar Card (Dev)',
  description: 'A bottom navbar with a lens that follows your finger (glass or flat, from the theme), plus per-route status dots, a live value readout, JS-templated icon symbols/colors/pulse, a persistent active-route highlight, a scrollable bar with snap-into-view, hover-delayed (or release-only) popup navigation to stay smooth on fast swipes, multiple route sets (modes) you switch by swiping the bar up or down, and per-user or per-state visibility for routes and modes. Sizing options have a visual editor.',
});
