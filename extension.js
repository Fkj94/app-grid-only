import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class AppGridOnlyExtension extends Extension {
    enable() {
        this._injectionManager = new InjectionManager();

        const overview = Main.overview;
        const controls = overview._overview._controls;
        const layoutManager = controls.layout_manager;
        const searchController = controls._searchController;
        const workspacesDisplay = controls._workspacesDisplay;

        const overviewProto = Object.getPrototypeOf(overview);
        const controlsProto = Object.getPrototypeOf(controls);
        const layoutProto = Object.getPrototypeOf(layoutManager);
        const searchControllerProto = Object.getPrototypeOf(searchController);
        const workspacesDisplayProto = Object.getPrototypeOf(workspacesDisplay);

        // 1. Force Overview to open directly into APP_GRID instead of WINDOW_PICKER
        this._injectionManager.overrideMethod(
            overviewProto,
            'show',
            originalMethod => function (state = OverviewControls.ControlsState.APP_GRID) {
                if (state === OverviewControls.ControlsState.WINDOW_PICKER)
                    state = OverviewControls.ControlsState.APP_GRID;
                return originalMethod.call(this, state);
            }
        );

        this._injectionManager.overrideMethod(
            overviewProto,
            '_animateVisible',
            originalMethod => function (state) {
                if (state === OverviewControls.ControlsState.WINDOW_PICKER)
                    state = OverviewControls.ControlsState.APP_GRID;
                return originalMethod.call(this, state);
            }
        );

        // 2. Adjust ControlsManagerLayout:
        // - In APP_GRID, eliminate workspace previews by giving them height 0 and placing them offscreen.
        this._injectionManager.overrideMethod(
            layoutProto,
            '_computeWorkspacesBoxForState',
            originalMethod => function (state, box, searchHeight, dashHeight, thumbnailsHeight, spacing) {
                if (state === OverviewControls.ControlsState.APP_GRID) {
                    const workspaceBox = box.copy();
                    const [width, height] = workspaceBox.get_size();
                    workspaceBox.set_origin(0, -height);
                    workspaceBox.set_size(width, 0);
                    return workspaceBox;
                }
                return originalMethod.call(this, state, box, searchHeight, dashHeight, thumbnailsHeight, spacing);
            }
        );

        // - In APP_GRID and HIDDEN, allocate AppDisplay starting immediately below the search entry,
        // using the full remaining vertical space down to the dash.
        this._injectionManager.overrideMethod(
            layoutProto,
            '_getAppDisplayBoxForState',
            originalMethod => function (state, box, searchHeight, dashHeight, workspacesBox, spacing) {
                if (state === OverviewControls.ControlsState.APP_GRID) {
                    const [width, height] = box.get_size();
                    const {y1: startY} = this._workAreaBox;
                    const appDisplayBox = new Clutter.ActorBox();
                    appDisplayBox.set_origin(0, startY + searchHeight + spacing);
                    appDisplayBox.set_size(
                        width,
                        height - searchHeight - spacing - dashHeight - spacing
                    );
                    return appDisplayBox;
                }
                if (state === OverviewControls.ControlsState.HIDDEN) {
                    const [width, height] = box.get_size();
                    const appDisplayBox = new Clutter.ActorBox();
                    appDisplayBox.set_origin(0, box.y2);
                    appDisplayBox.set_size(
                        width,
                        height - searchHeight - spacing - dashHeight - spacing
                    );
                    return appDisplayBox;
                }
                return originalMethod.call(this, state, box, searchHeight, dashHeight, workspacesBox, spacing);
            }
        );

        // 3. Adjust ControlsManager:
        // - Prevent switching to WINDOW_PICKER when shifting state or on rapid Super presses.
        this._injectionManager.overrideMethod(
            controlsProto,
            '_shiftState',
            originalMethod => function (direction) {
                if (direction === Meta.MotionDirection.DOWN) {
                    Main.overview.hide();
                    return;
                }
                if (direction === Meta.MotionDirection.UP) {
                    if (Main.overview.visible)
                        Main.overview.hide();
                    else
                        Main.overview.show(OverviewControls.ControlsState.APP_GRID);
                    return;
                }
                originalMethod.call(this, direction);
            }
        );

        // - Show Apps button on dash toggles directly between APP_GRID and closed (never WINDOW_PICKER).
        this._injectionManager.overrideMethod(
            controlsProto,
            '_onShowAppsButtonToggled',
            originalMethod => function () {
                if (this._ignoreShowAppsButtonToggle)
                    return;

                const checked = this.dash.showAppsButton.checked;
                if (!checked) {
                    Main.overview.hide();
                } else {
                    this._stateAdjustment.remove_transition('value');
                    this._stateAdjustment.ease(OverviewControls.ControlsState.APP_GRID, {
                        duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
                        mode: Clutter.AnimationMode.EASE_OUT_SINE,
                    });
                }
            }
        );

        // - When search is activated or cleared, ensure workspaces remain completely invisible.
        this._injectionManager.overrideMethod(
            controlsProto,
            '_onSearchChanged',
            originalMethod => function () {
                originalMethod.call(this);
                this._workspacesDisplay.opacity = 0;
                this._workspacesDisplay.visible = false;
                this._workspacesDisplay.reactive = false;
                this._workspacesDisplay.setPrimaryWorkspaceVisible(false);
                this._thumbnailsBox.opacity = 0;
                this._thumbnailsBox.visible = false;
                this._thumbnailsBox.reactive = false;
            }
        );

        // - Gestures: snap directly between HIDDEN and APP_GRID.
        this._injectionManager.overrideMethod(
            controlsProto,
            'gestureBegin',
            originalMethod => function (tracker) {
                const baseDistance = global.screen_height;
                const progress = this._stateAdjustment.value;
                const points = [
                    OverviewControls.ControlsState.HIDDEN,
                    OverviewControls.ControlsState.APP_GRID,
                ];

                const transition = this._stateAdjustment.get_transition('value');
                const cancelProgress = transition
                    ? transition.get_interval().peek_final_value()
                    : Math.round(progress);
                this._stateAdjustment.remove_transition('value');

                tracker.confirmSwipe(baseDistance, points, progress, cancelProgress);
                this.prepareToEnterOverview();
                this._stateAdjustment.gestureInProgress = true;
            }
        );

        this._injectionManager.overrideMethod(
            controlsProto,
            'gestureEnd',
            originalMethod => function (target, duration, onComplete) {
                if (target === OverviewControls.ControlsState.WINDOW_PICKER) {
                    target = this._stateAdjustment.value > 1.0
                        ? OverviewControls.ControlsState.APP_GRID
                        : OverviewControls.ControlsState.HIDDEN;
                }
                originalMethod.call(this, target, duration, onComplete);
            }
        );

        // 4. Adjust SearchController:
        // - When Escape is pressed, reset search if active; otherwise close the overview immediately.
        this._injectionManager.overrideMethod(
            searchControllerProto,
            '_onStageKeyPress',
            originalMethod => function () {
                if (Main.modalCount > 1)
                    return Clutter.EVENT_PROPAGATE;

                const [, symbol] = this._stageKeyController.get_key();
                if (symbol === Clutter.KEY_Escape) {
                    if (this._searchActive)
                        this.reset();
                    else
                        Main.overview.hide();
                    return Clutter.EVENT_STOP;
                }
                return originalMethod.call(this);
            }
        );

        // 5. Adjust WorkspacesDisplay:
        // - Ensure workspaces and secondary monitor views stay invisible when entering overview.
        this._injectionManager.overrideMethod(
            workspacesDisplayProto,
            'prepareToEnterOverview',
            originalMethod => function () {
                originalMethod.call(this);
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
            }
        );

        // Apply immediately to current live state
        if (overview.visible)
            overview.hide();

        workspacesDisplay.opacity = 0;
        workspacesDisplay.visible = false;
        workspacesDisplay.reactive = false;
        workspacesDisplay.setPrimaryWorkspaceVisible(false);

        controls._thumbnailsBox.opacity = 0;
        controls._thumbnailsBox.visible = false;
        controls._thumbnailsBox.reactive = false;

        layoutManager.layout_changed();
    }

    disable() {
        const overview = Main.overview;
        const controls = overview._overview._controls;
        const layoutManager = controls.layout_manager;
        const workspacesDisplay = controls._workspacesDisplay;

        if (overview.visible)
            overview.hide();

        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

        // Restore properties on components
        workspacesDisplay.opacity = 255;
        workspacesDisplay.visible = true;
        workspacesDisplay.reactive = true;
        workspacesDisplay.setPrimaryWorkspaceVisible(true);

        controls._thumbnailsBox.opacity = 255;
        controls._thumbnailsBox.visible = true;
        controls._thumbnailsBox.reactive = true;

        layoutManager.layout_changed();
    }
}
