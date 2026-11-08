
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {
    Extension,
    InjectionManager,
} from 'resource:///org/gnome/shell/extensions/extension.js';


export default class AppGridOnlyExtension extends Extension {
    enable() {
        if (this._injectionManager) {
            console.warn('[App Grid Only] Already enabled');
            return;
        }

        this._injectionManager = null;
        this._runtime = null;

        try {
            this._runtime = this._validateEnvironment();
            this._injectionManager = new InjectionManager();

            this._installOverrides(this._runtime);
            this._applyHiddenState(this._runtime);

            this._refreshLayout();

            console.info('[App Grid Only] Enabled');
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

        console.info('[App Grid Only] Disabled');
    }

    // ---------------------------------------------------------
    // Error handling and lifecycle
    // ---------------------------------------------------------

    _logError(context, error) {
        console.error(
            `[App Grid Only] ${context}: ${error?.stack ?? error}`
        );
    }

    _logWarning(context, error) {
        console.warn(
            `[App Grid Only] ${context}: ${error?.stack ?? error}`
        );
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
            const {
                workspacesDisplay,
                thumbnailsBox,
            } = runtime;

            if (workspacesDisplay) {
                workspacesDisplay.opacity = 255;
                workspacesDisplay.visible = true;
                workspacesDisplay.reactive = true;
                workspacesDisplay.setPrimaryWorkspaceVisible(true);

                if (workspacesDisplay._workspacesViews) {
                    for (const view of workspacesDisplay._workspacesViews) {
                        view.opacity = 255;
                        view.visible = true;
                        view.reactive = true;
                    }
                }
            }

            if (thumbnailsBox) {
                thumbnailsBox.opacity = 255;
                thumbnailsBox.visible = true;
                thumbnailsBox.reactive = true;
            }
        } catch (error) {
            this._logWarning('Failed to restore visual state', error);
        }
    }

    _applyHiddenState(runtime) {
        const {
            workspacesDisplay,
            thumbnailsBox,
        } = runtime;

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
            throw new Error('GNOME overview internals are unavailable');

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
                throw new Error('A required GNOME component is missing');

            for (const method of methods) {
                if (typeof object[method] !== 'function') {
                    throw new Error(`Missing GNOME method: ${method}`);
                }
            }
        }

        if (!thumbnailsBox)
            throw new Error('Workspace thumbnails box is unavailable');

        if (!showAppsButton ||
            typeof showAppsButton.checked !== 'boolean') {
            throw new Error('Show Apps button is unavailable');
        }

        if (typeof searchController._stageKeyController?.get_key !== 'function')
            throw new Error('Stage key controller is unavailable');

        const {
            WINDOW_PICKER,
            APP_GRID,
            HIDDEN,
        } = OverviewControls.ControlsState ?? {};

        if (![WINDOW_PICKER, APP_GRID, HIDDEN].every(Number.isFinite))
            throw new Error('GNOME overview states are unavailable');

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

        // 1. Always open the overview on APP_GRID.

        this._injectionManager.overrideMethod(
            overviewProto,
            'show',
            originalMethod => function (state = APP_GRID) {
                if (state === WINDOW_PICKER)
                    state = APP_GRID;

                return originalMethod.call(this, state);
            }
        );

        this._injectionManager.overrideMethod(
            overviewProto,
            '_animateVisible',
            originalMethod => function (state) {
                if (state === WINDOW_PICKER)
                    state = APP_GRID;

                return originalMethod.call(this, state);
            }
        );

        // 2. Workspace geometry.
        //
        // Keep the native geometry for all states except APP_GRID.
        // Do not return a zero-height workspace allocation.

        this._injectionManager.overrideMethod(
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

        this._injectionManager.overrideMethod(
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

        // 3. Show Apps button.

        this._injectionManager.overrideMethod(
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

        // 4. State navigation.

        this._injectionManager.overrideMethod(
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

        // 5. Search changes.

        this._injectionManager.overrideMethod(
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

        // 6. Preserve native gesture handling, but constrain
        // the gesture destination to HIDDEN and APP_GRID.

        this._injectionManager.overrideMethod(
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

        this._injectionManager.overrideMethod(
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

        // 7. Escape key.

        this._injectionManager.overrideMethod(
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

        // 8. WorkspacesDisplay visibility.

        this._injectionManager.overrideMethod(
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
    }
}
