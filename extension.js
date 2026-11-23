import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Small visual adjustment: keep the locked icon 3 px farther left.
const PANEL_ICON_LEFT_NUDGE = 3;

const SETTING_KEYS = [
    'enabled',
    'intensity',
    'thickness',
    'glow',
    'radius',
    'top-inset',
    'color-mode',
];

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export default class MacRinglightExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsSignals = [];
        this._overviewSignals = [];
        this._panelBoxSignals = [];
        this._panelPlacementIdle = 0;
        this._panelPlacementRetryId = 0;
        this._panelPlacementRetryCount = 0;
        this._networkMonitorActor = null;
        this._networkMonitorPanelBox = null;
        this._systemMonitorRoot = null;
        this._networkMonitorSignals = [];
        this._monitorWatchRefreshIdle = 0;
        this._positionSyncLater = 0;
        this._pinnedScreenX = null;
        this._frameUpdateIdle = 0;
        this._lastFrameStyle = null;
        this._lastFrameGeometry = null;

        // The frame is deliberately non-reactive: clicks pass through to apps.
        this._frame = new St.Widget({
            name: 'mac-ringlight-frame',
            reactive: false,
            can_focus: false,
            track_hover: false,
            visible: false,
        });

        // Keep the frame in the Shell chrome layer, but raise it to the
        // front of uiGroup so it visually overlays floating docks (as on
        // macOS). The actor is non-reactive, so pointer events still reach
        // the dock and its icons. The top inset keeps the frame below the
        // top-panel area even though this actor is stacked above uiGroup.
        Main.layoutManager.addChrome(this._frame, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        Main.layoutManager.uiGroup.set_child_above_sibling(this._frame, null);

        this._indicator = new PanelMenu.Button(0.0, 'Mac Ringlight', false);
        this._icon = new St.Icon({
            icon_name: 'display-brightness-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(this._icon);

        // Left-click toggles the ringlight immediately; right-click opens the menu.
        this._panelPressSignal = this._indicator.connect('button-press-event', (_actor, event) => {
            const button = event.get_button();

            if (button === 1) {
                this._settings.set_boolean(
                    'enabled',
                    !this._settings.get_boolean('enabled')
                );
                return Clutter.EVENT_STOP;
            }

            if (button === 3) {
                this._indicator.menu.open();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        this._switchItem = new PopupMenu.PopupSwitchMenuItem(
            'Ringlight',
            this._settings.get_boolean('enabled')
        );
        this._switchItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('enabled', state);
        });
        this._indicator.menu.addMenuItem(this._switchItem);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addAction('Preferences', () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        // Keep Ringlight immediately to the LEFT of Network Monitor.
        // Its horizontal screen position is compensated when the monitor
        // changes width, so live traffic digits cannot move the icon.
        this._watchPanelBoxes();
        this._schedulePanelPlacement();
        // Network Monitor may be started after this extension during login.
        // Retry discovery until its panel actor is present instead of pinning
        // Ringlight to a temporary/fallback position in the right panel box.
        this._startPanelPlacementRetry();

        for (const key of SETTING_KEYS) {
            const signalId = this._settings.connect(`changed::${key}`, () => {
                this._scheduleFrameUpdate();
            });
            this._settingsSignals.push(signalId);
        }

        this._monitorSignal = Main.layoutManager.connect('monitors-changed', () => {
            this._lastFrameGeometry = null;
            this._pinnedScreenX = null;
            this._schedulePanelPlacement();
            this._scheduleFrameUpdate();
        });

        this._overviewSignals.push(
            Main.overview.connect('showing', () => this._frame.hide()),
            Main.overview.connect('hiding', () => this._scheduleFrameUpdate())
        );

        this._updateFrame();
    }

    _scheduleFrameUpdate() {
        if (this._frameUpdateIdle)
            return;

        // Coalesce related GSettings and monitor notifications into one
        // render/layout pass on the next main-loop iteration.
        this._frameUpdateIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._frameUpdateIdle = 0;
            this._updateFrame();
            return GLib.SOURCE_REMOVE;
        });
    }

    _watchPanelBoxes() {
        const boxes = [
            Main.panel._leftBox,
            Main.panel._centerBox,
            Main.panel._rightBox,
        ].filter(Boolean);

        for (const box of boxes) {
            for (const signal of ['child-added', 'child-removed']) {
                const signalId = box.connect(signal, () => {
                    this._schedulePanelPlacement();
                });
                this._panelBoxSignals.push([box, signalId]);
            }
        }
    }

    _schedulePanelPlacement() {
        if (this._panelPlacementIdle)
            return;

        this._panelPlacementIdle = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._panelPlacementIdle = 0;
                this._placePanelIndicator();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _startPanelPlacementRetry() {
        if (this._panelPlacementRetryId || !this._indicator)
            return;

        this._panelPlacementRetryCount = 0;
        this._panelPlacementRetryId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            400,
            () => {
                if (!this._indicator) {
                    this._panelPlacementRetryId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                this._placePanelIndicator();
                this._panelPlacementRetryCount++;

                const target = this._findNetworkMonitor();
                const container = this._indicator?.container;
                if (target && container?.get_parent?.() === target.parent) {
                    const direction = this._getPanelChildOrderDirection(
                        target.parent, target.container, container
                    );
                    const children = target.parent.get_children();
                    const currentIndex = children.indexOf(container);
                    const targetIndex = children.indexOf(target.container);
                    const correctlyPlaced = direction > 0
                        ? currentIndex === targetIndex - 1
                        : direction < 0 && currentIndex === targetIndex + 1;
                    if (correctlyPlaced) {
                        this._panelPlacementRetryId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                }

                // Keep startup polling bounded. Panel child-added signals
                // continue to trigger discovery if the monitor loads later.
                if (this._panelPlacementRetryCount >= 75) {
                    this._panelPlacementRetryId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _describePanelActor(actor, depth = 0) {
        if (!actor)
            return '';

        const parts = [];
        try {
            const values = [
                actor.get_name?.(),
                actor.name,
                actor.get_accessible_name?.(),
                actor.accessible_name,
                actor.get_style_class_name?.(),
                actor.style_class,
                actor.text,
                actor.get_text?.(),
            ];
            for (const value of values) {
                if (typeof value === 'string' && value.length > 0)
                    parts.push(value);
            }
        } catch (_) {
            // Some panel actors expose properties that are not readable.
        }

        if (depth < 1) {
            try {
                for (const child of actor.get_children?.() ?? [])
                    parts.push(this._describePanelActor(child, depth + 1));
            } catch (_) {
                // Continue with the information collected from this actor.
            }
        }

        return parts.join(' ');
    }

    _getActorScreenRect(actor) {
        if (!actor || !actor.visible)
            return null;

        try {
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            if (!Number.isFinite(x) || !Number.isFinite(y) ||
                !Number.isFinite(width) || !Number.isFinite(height) ||
                width <= 0 || height <= 0)
                return null;
            return {x, y, width, height};
        } catch (_) {
            return null;
        }
    }

    _findNetworkMonitor() {
        // System Monitor v20 has one _panelBox with CPU/RAM/swap and
        // separate upload/download groups. Select by actual screen position;
        // child-array order is not guaranteed to match left-to-right order
        // in the GNOME panel (notably in the right-aligned panel box).
        const sysmon = Main.panel.statusArea?.['sysmonitor@talhasiddique7'];
        const panelBox = sysmon?._panelBox;
        if (!sysmon || !panelBox)
            return null;

        const candidates = [
            sysmon._upGroup?.box,
            sysmon._downGroup?.box,
        ].filter(actor => actor && actor.get_parent?.() === panelBox && actor.visible);

        const allocated = candidates
            .map(actor => ({actor, rect: this._getActorScreenRect(actor)}))
            .filter(item => item.rect !== null);

        // During login an actor can exist before it receives a real allocation.
        // Wait for panel layout rather than falling back to a potentially
        // incorrect child index and inserting Ringlight among CPU/RAM metrics.
        if (allocated.length === 0)
            return null;

        if (this._networkMonitorActor &&
            allocated.some(item => item.actor === this._networkMonitorActor)) {
            return {
                container: this._networkMonitorActor,
                parent: panelBox,
                sysmon,
            };
        }

        allocated.sort((a, b) => a.rect.x - b.rect.x);
        return {
            container: allocated[0].actor,
            parent: panelBox,
            sysmon,
        };
    }

    _getPanelChildOrderDirection(panelBox, targetActor, excludedActor) {
        // Return +1 when increasing child indices move right on screen,
        // or -1 when increasing child indices move left (RTL/reversed layout).
        const children = panelBox.get_children().filter(child => child !== excludedActor);
        const targetIndex = children.indexOf(targetActor);
        if (targetIndex < 0)
            return 0;

        const positioned = [];
        for (let i = 0; i < children.length; i++) {
            const rect = this._getActorScreenRect(children[i]);
            if (rect)
                positioned.push({index: i, x: rect.x});
        }

        const deltas = [];
        for (let i = 1; i < positioned.length; i++) {
            const delta = positioned[i].x - positioned[i - 1].x;
            if (Math.abs(delta) > 0.5)
                deltas.push(delta);
        }

        if (deltas.length === 0)
            return 0;

        const positive = deltas.filter(delta => delta > 0).length;
        const negative = deltas.filter(delta => delta < 0).length;
        if (positive === negative)
            return 0;
        return positive > negative ? 1 : -1;
    }

    _placePanelIndicator() {
        const container = this._indicator?.container;
        if (!container)
            return;

        const networkMonitor = this._findNetworkMonitor();
        const targetBox = networkMonitor?.parent ?? null;
        const targetActor = networkMonitor?.container ?? null;

        // Wait for the actual System Monitor network metric. Never fall back
        // to the main right panel box: that was the source of the wrong slot.
        if (!targetBox || !targetActor) {
            if (this._networkMonitorActor) {
                this._disconnectNetworkMonitorSignals();
                this._networkMonitorActor = null;
                this._networkMonitorPanelBox = null;
                this._systemMonitorRoot = null;
                this._pinnedScreenX = null;
            }
            this._startPanelPlacementRetry();
            return;
        }

        // Determine visual direction from allocated child coordinates.
        // In a reversed/right-to-left panel layout the screen-left insertion
        // point is AFTER the target in child-array order, not before it.
        const siblings = targetBox.get_children().filter(child => child !== container);
        const networkIndex = siblings.indexOf(targetActor);
        if (networkIndex < 0)
            return;

        const direction = this._getPanelChildOrderDirection(targetBox, targetActor, container);
        if (direction === 0) {
            // Layout is not stable/allocated yet. Do not guess and risk placing
            // Ringlight between CPU and RAM; retry after the next allocation.
            this._startPanelPlacementRetry();
            return;
        }

        // Commit the target only after the screen direction is known.
        // This keeps startup retry active while System Monitor is allocating.
        this._watchNetworkMonitorWidth(targetActor, targetBox, networkMonitor.sysmon);

        const insertionIndex = direction > 0 ? networkIndex : networkIndex + 1;
        const currentParent = container.get_parent();
        if (currentParent === targetBox) {
            const currentChildren = targetBox.get_children();
            const currentIndex = currentChildren.indexOf(container);
            const targetIndex = currentChildren.indexOf(targetActor);
            const alreadyOnScreenLeft = direction > 0
                ? currentIndex === targetIndex - 1
                : currentIndex === targetIndex + 1;
            if (currentIndex >= 0 && targetIndex >= 0 && alreadyOnScreenLeft) {
                this._schedulePinnedPositionSync();
                return;
            }
        }

        if (currentParent)
            currentParent.remove_child(container);

        targetBox.insert_child_at_index(container, insertionIndex);
        this._schedulePinnedPositionSync();
    }

    _disconnectNetworkMonitorSignals() {
        for (const [actor, signalId] of this._networkMonitorSignals) {
            try {
                actor.disconnect(signalId);
            } catch (_) {
                // The actor may already have been destroyed by its extension.
            }
        }
        this._networkMonitorSignals = [];
    }

    _connectPositionSignal(actor, signal, callback) {
        try {
            const signalId = actor.connect(signal, callback);
            this._networkMonitorSignals.push([actor, signalId]);
        } catch (_) {
            // Not every Clutter/St actor implements every optional signal.
        }
    }

    _watchNetworkMonitorWidth(actor, panelBox, sysmon) {
        const sameSystemMonitor =
            panelBox === this._networkMonitorPanelBox &&
            sysmon === this._systemMonitorRoot;

        if (actor === this._networkMonitorActor && sameSystemMonitor) {
            this._schedulePinnedPositionSync();
            return;
        }

        this._disconnectNetworkMonitorSignals();

        // Preserve the screen pin if upload/download changes which group is
        // selected, provided the enclosing System Monitor instance is the same.
        // Only a genuinely new System Monitor panel actor gets a new baseline.
        if (!sameSystemMonitor)
            this._pinnedScreenX = null;

        this._networkMonitorActor = actor;
        this._networkMonitorPanelBox = panelBox;
        this._systemMonitorRoot = sysmon;
        this._attachSystemMonitorPositionWatchers(sysmon);
        this._schedulePinnedPositionSync();
    }

    _attachSystemMonitorPositionWatchers(sysmon) {
        if (!sysmon)
            return;

        const scheduleSync = () => this._schedulePinnedPositionSync();
        const refreshAndSync = () => {
            this._scheduleMonitorWatchRefresh();
            this._schedulePinnedPositionSync();
        };
        const watched = new Set();

        const watchLayoutActor = actor => {
            if (!actor || watched.has(actor))
                return;
            watched.add(actor);
            for (const signal of [
                'notify::width',
                'notify::x',
                'allocation-changed',
            ]) {
                this._connectPositionSignal(actor, signal, scheduleSync);
            }
        };

        const watchActorTree = actor => {
            if (!actor || watched.has(actor))
                return;
            watched.add(actor);

            // Watch size, position, allocation and text changes. The values
            // are updated on separate labels inside CPU/RAM/upload/download;
            // a change anywhere in the row can shift the whole status area.
            for (const signal of [
                'notify::width',
                'notify::x',
                'notify::text',
                'allocation-changed',
            ]) {
                this._connectPositionSignal(actor, signal, scheduleSync);
            }
            this._connectPositionSignal(actor, 'child-added', refreshAndSync);
            this._connectPositionSignal(actor, 'child-removed', refreshAndSync);

            try {
                for (const child of actor.get_children?.() ?? [])
                    watchActorTree(child);
            } catch (_) {
                // Keep all watchers already installed in this subtree.
            }
        };

        // Watch the entire System Monitor tree, not just the selected network
        // group. This catches text/width updates in either network speed label
        // and in CPU/RAM values that can reflow the same right-panel cluster.
        watchActorTree(sysmon);

        // Also watch each ancestor and its siblings without recursively walking
        // the entire GNOME panel. The right-panel container may move as its
        // preferred width changes.
        let node = sysmon;
        while (node && node !== Main.panel) {
            watchLayoutActor(node);
            const parent = node.get_parent?.();
            if (!parent)
                break;

            watchLayoutActor(parent);
            try {
                for (const sibling of parent.get_children?.() ?? [])
                    watchLayoutActor(sibling);
            } catch (_) {
                // The parent may be replaced during panel reconstruction.
            }
            node = parent;
        }
    }

    _scheduleMonitorWatchRefresh() {
        if (this._monitorWatchRefreshIdle)
            return;

        this._monitorWatchRefreshIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._monitorWatchRefreshIdle = 0;
            const sysmon = this._systemMonitorRoot;
            this._disconnectNetworkMonitorSignals();
            this._attachSystemMonitorPositionWatchers(sysmon);
            this._schedulePinnedPositionSync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _schedulePinnedPositionSync() {
        if (this._positionSyncLater || !this._indicator?.container)
            return;

        const laters = global.compositor.get_laters();
        this._positionSyncLater = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._positionSyncLater = 0;
            this._syncPinnedScreenPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncPinnedScreenPosition() {
        const container = this._indicator?.container;
        if (!container || !this._networkMonitorActor ||
            !this._networkMonitorPanelBox ||
            container.get_parent() !== this._networkMonitorPanelBox)
            return;

        // Read the actual transformed screen coordinate after GNOME has
        // completed layout, instead of guessing from a width delta.
        const [screenX] = container.get_transformed_position();
        if (!Number.isFinite(screenX))
            return;

        if (this._pinnedScreenX === null)
            this._pinnedScreenX = screenX - PANEL_ICON_LEFT_NUDGE;

        const correction = this._pinnedScreenX - screenX;
        if (Math.abs(correction) > 0.10)
            container.translation_x = container.translation_x + correction;
    }

    _updateFrame() {
        if (!this._frame || !this._settings)
            return;

        const enabled = this._settings.get_boolean('enabled');
        this._switchItem?.setToggleState(enabled);

        // A dimmed panel icon makes the OFF state visible at a glance.
        if (this._icon)
            this._icon.opacity = enabled ? 255 : 105;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !enabled) {
            this._frame.hide();
            return;
        }

        const width = monitor.width;
        const height = monitor.height;
        const shortSide = Math.min(width, height);

        // Geometry follows the proportions of the supplied macOS reference.
        const sideInset = shortSide * 0.004;
        const requestedTopInset = height * clamp(this._settings.get_double('top-inset'), 0.01, 0.08);
        const panelHeight = Main.layoutManager.panelBox.get_height();
        const topInset = Math.max(requestedTopInset, panelHeight + 4);
        // Keep the lower edge close to the screen edge. The ringlight is
        // intentionally drawn in front of the dock, not moved above it.
        const bottomInset = height * 0.005;
        const thickness = clamp(this._settings.get_double('thickness'), 0.035, 0.12) * shortSide;
        const radius = clamp(this._settings.get_double('radius'), 0.10, 0.25) * shortSide;
        const intensity = clamp(this._settings.get_double('intensity'), 0.35, 1.5);
        const glow = clamp(this._settings.get_double('glow'), 0.0, 1.0);

        const frameX = Math.round(monitor.x + sideInset);
        const frameY = Math.round(monitor.y + topInset);
        const frameWidth = Math.max(1, Math.round(width - 2 * sideInset));
        const frameHeight = Math.max(1, Math.round(height - topInset - bottomInset));
        const geometryKey = `${frameX}:${frameY}:${frameWidth}:${frameHeight}`;
        if (this._lastFrameGeometry !== geometryKey) {
            this._frame.set_position(frameX, frameY);
            this._frame.set_size(frameWidth, frameHeight);
            this._lastFrameGeometry = geometryKey;
        }

        const blurA = Math.round(shortSide * 0.025 * glow);
        const blurB = Math.round(shortSide * 0.060 * glow);
        const blurC = Math.round(shortSide * 0.105 * glow);
        const borderAlpha = clamp(0.88 + 0.10 * intensity, 0, 1).toFixed(3);
        const glowAlphaA = clamp(0.72 * glow * intensity, 0, 0.96).toFixed(3);
        const glowAlphaB = clamp(0.50 * glow * intensity, 0, 0.82).toFixed(3);
        const glowAlphaC = clamp(0.28 * glow * intensity, 0, 0.60).toFixed(3);
        const innerAlpha = clamp(0.35 * intensity, 0, 0.62).toFixed(3);

        // Three deliberately distinct color temperatures. Warm uses a
        // stronger amber/orange tint so it remains visibly different from
        // the white ring even at high display brightness.
        const palettes = {
            white: {
                border: '250, 253, 255',
                glowA: '255, 255, 255',
                glowB: '155, 211, 255',
                inner: '255, 255, 255',
            },
            warm: {
                border: '255, 190, 120',
                glowA: '255, 151, 72',
                glowB: '255, 103, 35',
                inner: '255, 224, 188',
            },
            natural: {
                border: '255, 246, 229',
                glowA: '255, 242, 222',
                glowB: '224, 220, 207',
                inner: '255, 251, 242',
            },
        };
        const colorMode = this._settings.get_string('color-mode');
        const palette = palettes[colorMode] ?? palettes.white;

        // Rebuild the complete inline style whenever the selected temperature
        // changes; border-color is explicit rather than inherited from a
        // previous shorthand declaration.
        const style = `
            background-color: transparent;
            border: ${Math.round(thickness)}px solid rgba(${palette.border}, ${borderAlpha});
            border-color: rgba(${palette.border}, ${borderAlpha});
            border-radius: ${Math.round(radius)}px;
            box-shadow:
                0 0 ${blurA}px ${Math.round(blurA * 0.28)}px rgba(${palette.glowA}, ${glowAlphaA}),
                0 0 ${blurB}px ${Math.round(blurB * 0.24)}px rgba(${palette.glowB}, ${glowAlphaB}),
                0 0 ${blurC}px ${Math.round(blurC * 0.12)}px rgba(${palette.glowB}, ${glowAlphaC}),
                inset 0 0 ${Math.round(thickness * 0.30)}px rgba(${palette.inner}, ${innerAlpha});
        `;

        if (this._lastFrameStyle !== style) {
            this._frame.set_style(style);
            this._lastFrameStyle = style;
        }

        if (!this._frame.visible)
            this._frame.show();
    }

    disable() {
        if (this._settings && this._settingsSignals) {
            for (const signalId of this._settingsSignals)
                this._settings.disconnect(signalId);
        }
        this._settingsSignals = [];

        if (this._monitorSignal) {
            Main.layoutManager.disconnect(this._monitorSignal);
            this._monitorSignal = 0;
        }

        if (this._overviewSignals) {
            for (const signalId of this._overviewSignals)
                Main.overview.disconnect(signalId);
        }
        this._overviewSignals = [];

        if (this._frameUpdateIdle) {
            GLib.Source.remove(this._frameUpdateIdle);
            this._frameUpdateIdle = 0;
        }

        if (this._panelPlacementIdle) {
            GLib.Source.remove(this._panelPlacementIdle);
            this._panelPlacementIdle = 0;
        }

        if (this._panelPlacementRetryId) {
            GLib.Source.remove(this._panelPlacementRetryId);
            this._panelPlacementRetryId = 0;
        }
        this._panelPlacementRetryCount = 0;

        if (this._monitorWatchRefreshIdle) {
            GLib.Source.remove(this._monitorWatchRefreshIdle);
            this._monitorWatchRefreshIdle = 0;
        }

        if (this._positionSyncLater) {
            global.compositor.get_laters().remove(this._positionSyncLater);
            this._positionSyncLater = 0;
        }

        for (const [box, signalId] of this._panelBoxSignals ?? []) {
            try {
                box.disconnect(signalId);
            } catch (_) {
                // The panel box may already have been destroyed by Shell.
            }
        }
        this._panelBoxSignals = [];

        this._disconnectNetworkMonitorSignals();
        this._networkMonitorActor = null;
        this._networkMonitorPanelBox = null;
        this._systemMonitorRoot = null;
        this._pinnedScreenX = null;

        if (this._frame) {
            Main.layoutManager.removeChrome(this._frame);
            this._frame.destroy();
            this._frame = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._icon = null;
        this._panelPressSignal = 0;
        this._switchItem = null;
        this._settings = null;
    }
}
