
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {
    Extension,
    InjectionManager,
} from 'resource:///org/gnome/shell/extensions/extension.js';

class ExtensionError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ExtensionError';
        this.code = code;
    }
}


export default class AppGridOnlyExtension extends Extension {
    enable() {
        if (this._injectionManager) {
            console.warn('[App Grid Only] Already enabled');
            return;
        }

        this._injectionManager = null;
        this._runtime = null;
        this._reportedErrors = new Map();
        this._logSequence = 0;

        try {
            this._runtime = this._validateEnvironment();
            this._injectionManager = new InjectionManager();

            this._installOverrides(this._runtime);
            this._applyHiddenState(this._runtime);

            this._refreshLayout();

            this._logEvent('info', 'extension-enabled');
        } catch (error) {
            this._logError('Activation failed', error);
            this._restoreOverrides();
            this._runtime = null;
            throw error;
        }
    }

    disable() {
        this._restoreOverrides();
        this._runtime = null;
        this._flushSuppressedErrors();

        this._logEvent('info', 'extension-disabled');
    }

    // ---------------------------------------------------------
    // Error handling and lifecycle
    // ---------------------------------------------------------

    _logEvent(level, event, details = {}) {
        const logger = level === 'error'
            ? console.error
            : level === 'warning' ? console.warn : console.info;
        const record = {
            extension: 'app-grid-only',
            sequence: ++this._logSequence,
            timestamp: new Date().toISOString(),
            level,
            event,
            ...details,
        };

        logger.call(console, `[App Grid Only] ${JSON.stringify(record)}`);
    }

    _report(level, context, error) {
        const code = error?.code ?? 'UNEXPECTED_ERROR';
        const message = error?.message ?? String(error);
        const key = `${level}:${context}:${code}:${message}`;
        const report = this._reportedErrors?.get(key);

        if (report) {
            report.count++;
            return;
        }

        this._reportedErrors ??= new Map();
        this._reportedErrors.set(key, {count: 1, context, code, message});

        const recovery = code === 'GNOME_API_MISMATCH'
            ? 'Check the supported GNOME Shell versions for this extension.'
            : 'If this continues, include this error and the GNOME Shell version in a bug report.';
        this._logEvent(level, 'error', {
            context,
            code,
            message,
            recovery,
            stack: error?.stack ?? null,
        });
    }

    _logError(context, error) {
        this._report('error', context, error);
    }

    _logWarning(context, error) {
        this._report('warning', context, error);
    }

    _flushSuppressedErrors() {
        const reports = this._reportedErrors?.values() ?? [];

        for (const {count, context, code, message} of reports) {
            if (count > 1) {
                this._logEvent('info', 'repeated-errors-suppressed', {
                    count: count - 1,
                    context,
                    code,
                    message,
                });
            }
        }

        this._reportedErrors?.clear();
    }

    _refreshLayout() {
        try {
            this._runtime?.layoutManager?.layout_changed();
        } catch (error) {
            this._logWarning('Failed to refresh layout', error);
        }
    }

    _restoreOverrides() {
        try {
            this._injectionManager?.clear();
        } catch (error) {
            this._logError('Failed to restore GNOME methods', error);
        } finally {
            this._injectionManager = null;
        }

        this._restoreVisualState();
        this._refreshLayout();
    }

    _restoreVisualState() {
        const runtime = this._runtime;

        if (!runtime)
            return;

        try {
            for (const [actor, state] of runtime.visualState) {
                if (!actor)
                    continue;

                actor.opacity = state.opacity;
                actor.visible = state.visible;
                actor.reactive = state.reactive;
            }

            runtime.workspacesDisplay.setPrimaryWorkspaceVisible(
                runtime.primaryWorkspaceVisible
            );
        } catch (error) {
            this._logWarning('Failed to restore visual state', error);
        }
    }

    _applyHiddenState(runtime) {
        const {
            workspacesDisplay,
            thumbnailsBox,
        } = runtime;

        // Keep the exact pre-extension state so disabling the extension
        // does not override GNOME's own visibility decisions.
        runtime.visualState = new Map();
        const remember = actor => {
            if (actor && !runtime.visualState.has(actor)) {
                runtime.visualState.set(actor, {
                    opacity: actor.opacity,
                    visible: actor.visible,
                    reactive: actor.reactive,
                });
            }
        };

        remember(workspacesDisplay);
        remember(thumbnailsBox);
        for (const view of workspacesDisplay._workspacesViews ?? [])
            remember(view);
        runtime.primaryWorkspaceVisible =
            workspacesDisplay._primaryWorkspaceVisible ?? true;

        workspacesDisplay.opacity = 0;
        workspacesDisplay.visible = false;
        workspacesDisplay.reactive = false;
        workspacesDisplay.setPrimaryWorkspaceVisible(false);

        if (workspacesDisplay._workspacesViews) {
            for (const view of workspacesDisplay._workspacesViews) {
                view.opacity = 0;
                view.visible = false;
                view.reactive = false;
            }
        }

        thumbnailsBox.opacity = 0;
        thumbnailsBox.visible = false;
        thumbnailsBox.reactive = false;
    }

    // ---------------------------------------------------------
    // Environment validation
    // ---------------------------------------------------------

    _validateEnvironment() {
        const overview = Main.overview;
        const controls = overview?._overview?._controls;

        if (!overview || !controls)
            throw new ExtensionError(
                'GNOME_API_MISMATCH',
                'The GNOME overview controls could not be found.'
            );

        const layoutManager = controls.layout_manager;
        const searchController = controls._searchController;
        const stateAdjustment = controls._stateAdjustment;
        const workspacesDisplay = controls._workspacesDisplay;
        const thumbnailsBox = controls._thumbnailsBox;
        const showAppsButton = controls.dash?.showAppsButton;

        const requiredMethods = [
            [overview, [
                'show',
                '_animateVisible',
                'hide',
            ]],

            [controls, [
                '_getThumbnailsBoxParams',
                '_onShowAppsButtonToggled',
                '_onSearchChanged',
                '_shiftState',
                'gestureBegin',
                'gestureEnd',
            ]],

            [layoutManager, [
                'layout_changed',
                '_computeWorkspacesBoxForState',
                '_getAppDisplayBoxForState',
            ]],

            [searchController, [
                '_onStageKeyPress',
                'reset',
            ]],

            [stateAdjustment, [
                'ease',
                'getStateTransitionParams',
                'remove_transition',
            ]],

            [workspacesDisplay, [
                'prepareToEnterOverview',
                'setPrimaryWorkspaceVisible',
            ]],
        ];

        for (const [object, methods] of requiredMethods) {
            if (!object)
                throw new ExtensionError(
                    'GNOME_API_MISMATCH',
                    'A required GNOME overview component is missing.'
                );

            for (const method of methods) {
                if (typeof object[method] !== 'function') {
                    throw new ExtensionError(
                        'GNOME_API_MISMATCH',
                        `Required GNOME method “${method}” is unavailable.`
                    );
                }
            }
        }

        if (!thumbnailsBox)
            throw new ExtensionError(
                'GNOME_API_MISMATCH',
                'The workspace thumbnails component is unavailable.'
            );

        if (!showAppsButton ||
            typeof showAppsButton.checked !== 'boolean') {
            throw new ExtensionError(
                'GNOME_API_MISMATCH',
                'The native Show Apps button is unavailable.'
            );
        }

        if (typeof searchController._stageKeyController?.get_key !== 'function')
            throw new ExtensionError(
                'GNOME_API_MISMATCH',
                'The stage keyboard controller is unavailable.'
            );

        const {
            WINDOW_PICKER,
            APP_GRID,
            HIDDEN,
        } = OverviewControls.ControlsState ?? {};

        if (![WINDOW_PICKER, APP_GRID, HIDDEN].every(Number.isFinite))
            throw new ExtensionError(
                'GNOME_API_MISMATCH',
                'GNOME overview state constants are unavailable.'
            );

        return {
            overview,
            controls,
            layoutManager,
            searchController,
            stateAdjustment,
            workspacesDisplay,
            thumbnailsBox,

            overviewProto: Object.getPrototypeOf(overview),
            controlsProto: Object.getPrototypeOf(controls),
            layoutProto: Object.getPrototypeOf(layoutManager),
            searchControllerProto: Object.getPrototypeOf(searchController),
            workspacesDisplayProto: Object.getPrototypeOf(workspacesDisplay),
        };
    }

    // ---------------------------------------------------------
    // Overrides
    // ---------------------------------------------------------

    _installOverrides(runtime) {
        const {
            overviewProto,
            controlsProto,
            layoutProto,
            searchControllerProto,
            workspacesDisplayProto,
        } = runtime;

        const {
            WINDOW_PICKER,
            APP_GRID,
            HIDDEN,
        } = OverviewControls.ControlsState;

        const animationDuration =
            OverviewControls.SIDE_CONTROLS_ANIMATION_TIME;

        const overrideMethod = (target, methodName, createMethod) => {
            const extension = this;
            this._injectionManager.overrideMethod(
                target,
                methodName,
                originalMethod => {
                    const implementation = createMethod(originalMethod);

                    return function (...args) {
                        try {
                            return implementation.apply(this, args);
                        } catch (error) {
                            extension._logError(
                                `GNOME hook ${methodName}`,
                                error
                            );
                            throw error;
                        }
                    };
                }
            );
        };

        const installGroup = (name, installer) => {
            this._logEvent('debug', 'override-group-start', {group: name});
            try {
                installer();
                this._logEvent('debug', 'override-group-ready', {group: name});
            } catch (error) {
                this._logError(`installing override group ${name}`, error);
                throw error;
            }
        };

        installGroup('overview-entry', () => {
            // 1. Always open the overview on APP_GRID.

            overrideMethod(
                overviewProto,
                'show',
                originalMethod => function (state = APP_GRID) {
                    if (state === WINDOW_PICKER)
                        state = APP_GRID;

                    return originalMethod.call(this, state);
                }
            );

            overrideMethod(
                overviewProto,
                '_animateVisible',
                originalMethod => function (state) {
                    if (state === WINDOW_PICKER)
                        state = APP_GRID;

                    return originalMethod.call(this, state);
                }
            );

        });

        installGroup('workspace-layout', () => {
            // 2. Workspace geometry.
            //
            // Keep the native geometry for all states except APP_GRID.
            // Do not return a zero-height workspace allocation.

            overrideMethod(
                layoutProto,
                '_computeWorkspacesBoxForState',
                originalMethod => function (
                    state,
                    box,
                    searchHeight,
                    dashHeight,
                    thumbnailsHeight,
                    spacing,
                    ...args
                ) {
                    if (state !== APP_GRID)
                        return originalMethod.call(
                            this,
                            state,
                            box,
                            searchHeight,
                            dashHeight,
                            thumbnailsHeight,
                            spacing,
                            ...args
                        );

                    const workspaceBox = box.copy();
                    const [width, height] = workspaceBox.get_size();

                    if (!Number.isFinite(width) ||
                        !Number.isFinite(height) ||
                        width < 0 ||
                        height < 0) {
                        return originalMethod.call(
                            this,
                            state,
                            box,
                            searchHeight,
                            dashHeight,
                            thumbnailsHeight,
                            spacing,
                            ...args
                        );
                    }

                    // Preserve a valid allocation while moving the
                    // workspace region outside the visible area.
                    workspaceBox.set_origin(0, -height);

                    return workspaceBox;
                }
            );

            overrideMethod(
                layoutProto,
                '_getAppDisplayBoxForState',
                originalMethod => function (
                    state,
                    box,
                    searchHeight,
                    dashHeight,
                    workspacesBox,
                    spacing,
                    ...args
                ) {
                    if (state !== APP_GRID && state !== HIDDEN) {
                        return originalMethod.call(
                            this,
                            state,
                            box,
                            searchHeight,
                            dashHeight,
                            workspacesBox,
                            spacing,
                            ...args
                        );
                    }

                    const [width, height] = box.get_size();
                    const startY = state === APP_GRID
                        ? this._workAreaBox.y1 + searchHeight + spacing
                        : box.y2;

                    const appHeight =
                        height - searchHeight - dashHeight - 2 * spacing;

                    if (
                        !Number.isFinite(width) ||
                        !Number.isFinite(height) ||
                        !Number.isFinite(startY) ||
                        !Number.isFinite(appHeight) ||
                        width < 0 ||
                        appHeight < 0
                    ) {
                        return originalMethod.call(
                            this,
                            state,
                            box,
                            searchHeight,
                            dashHeight,
                            workspacesBox,
                            spacing,
                            ...args
                        );
                    }

                    const appDisplayBox = new Clutter.ActorBox();

                    appDisplayBox.set_origin(0, startY);
                    appDisplayBox.set_size(width, appHeight);

                    return appDisplayBox;
                }
            );

        });

        installGroup('show-apps-button', () => {
            // 3. Show Apps button.

            overrideMethod(
                controlsProto,
                '_onShowAppsButtonToggled',
                originalMethod => function (...args) {
                    if (this._ignoreShowAppsButtonToggle)
                        return;

                    const button = this.dash?.showAppsButton;

                    if (!button)
                        return originalMethod.apply(this, args);

                    if (!button.checked) {
                        Main.overview.hide();
                        return;
                    }

                    this._stateAdjustment.remove_transition('value');

                    this._stateAdjustment.ease(APP_GRID, {
                        duration: animationDuration,
                        mode: Clutter.AnimationMode.EASE_OUT_SINE,
                });
            }
        );

        });

        installGroup('state-navigation', () => {
            // 4. State navigation.

            overrideMethod(
                controlsProto,
                '_shiftState',
                originalMethod => function (direction, ...args) {
                    if (direction === Meta.MotionDirection.DOWN) {
                        if (Main.overview.visible)
                            Main.overview.hide();

                        return;
                    }

                    if (direction === Meta.MotionDirection.UP) {
                        if (!Main.overview.visible) {
                            Main.overview.show(APP_GRID);
                            return;
                        }

                        const transitionParams =
                            this._stateAdjustment.getStateTransitionParams();

                        const finalState = transitionParams?.finalState;

                        if (
                            Number.isFinite(finalState) &&
                            finalState < APP_GRID
                        ) {
                            this._stateAdjustment.remove_transition('value');

                            this._stateAdjustment.ease(APP_GRID, {
                                duration: animationDuration,
                                mode: Clutter.AnimationMode.EASE_OUT_QUAD,

                                onComplete: () => {
                                    const button = this.dash?.showAppsButton;

                                    if (button)
                                        button.checked = true;
                                },
                        });
                    }

                    return;
                }

                return originalMethod.call(this, direction, ...args);
            }
        );

        });

        installGroup('search-visibility', () => {
            // 5. Search changes.

            overrideMethod(
                controlsProto,
                '_onSearchChanged',
                originalMethod => function (...args) {
                    const result = originalMethod.apply(this, args);

                    const workspacesDisplay = this._workspacesDisplay;
                    const thumbnailsBox = this._thumbnailsBox;

                    if (workspacesDisplay) {
                        workspacesDisplay.opacity = 0;
                        workspacesDisplay.visible = false;
                        workspacesDisplay.reactive = false;
                        workspacesDisplay.setPrimaryWorkspaceVisible(false);
                    }

                    if (thumbnailsBox) {
                        thumbnailsBox.opacity = 0;
                        thumbnailsBox.visible = false;
                        thumbnailsBox.reactive = false;
                    }

                    return result;
                }
            );

        });

        installGroup('native-gestures', () => {
            // 6. Preserve native gesture handling, but constrain
            // the gesture destination to HIDDEN and APP_GRID.

            overrideMethod(
                controlsProto,
                'gestureBegin',
                originalMethod => function (tracker, ...args) {
                    const baseDistance = global.screen_height;
                    const progress = this._stateAdjustment.value;

                    const points = [HIDDEN, APP_GRID];

                    const transition =
                        this._stateAdjustment.get_transition('value');

                    const cancelProgress = transition
                        ? transition.get_interval().peek_final_value()
                        : Math.round(progress);

                    this._stateAdjustment.remove_transition('value');

                    tracker.confirmSwipe(
                        baseDistance,
                        points,
                        progress,
                        cancelProgress
                    );

                    this.prepareToEnterOverview();
                    this._stateAdjustment.gestureInProgress = true;
                }
            );

            overrideMethod(
                controlsProto,
                'gestureEnd',
                originalMethod => function (
                    target,
                    duration,
                    onComplete,
                    ...args
                ) {
                    if (target === WINDOW_PICKER) {
                        target = this._stateAdjustment.value > 1.0
                            ? APP_GRID
                            : HIDDEN;
                    }

                    return originalMethod.call(
                        this,
                        target,
                        duration,
                        onComplete,
                        ...args
                    );
                }
            );

        });

        installGroup('escape-key', () => {
            // 7. Escape key.

            overrideMethod(
                searchControllerProto,
                '_onStageKeyPress',
                originalMethod => function (...args) {
                    if (Main.modalCount > 1)
                        return Clutter.EVENT_PROPAGATE;

                    const keyController = this._stageKeyController;

                    if (typeof keyController?.get_key !== 'function')
                        return originalMethod.apply(this, args);

                    const [, symbol] = keyController.get_key();

                    if (symbol !== Clutter.KEY_Escape)
                        return originalMethod.apply(this, args);

                    if (this._searchActive)
                        this.reset();
                    else
                        Main.overview.hide();

                    return Clutter.EVENT_STOP;
                }
            );

        });

        installGroup('workspace-visibility', () => {
            // 8. WorkspacesDisplay visibility.

            overrideMethod(
                workspacesDisplayProto,
                'prepareToEnterOverview',
                originalMethod => function (...args) {
                    const result = originalMethod.apply(this, args);

                    this.opacity = 0;
                    this.visible = false;
                    this.reactive = false;
                    this.setPrimaryWorkspaceVisible(false);

                    if (this._workspacesViews) {
                        for (const view of this._workspacesViews) {
                            view.opacity = 0;
                            view.visible = false;
                            view.reactive = false;
                        }
                    }

                    return result;
                }
            );
        });


    }
}
