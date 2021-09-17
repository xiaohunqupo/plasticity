import { CompositeDisposable, Disposable } from "event-kit";
import * as THREE from "three";
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js';
import { EditorSignals } from '../../editor/EditorSignals';
import { DatabaseLike } from "../../editor/GeometryDatabase";
import { EditorOriginator } from "../../editor/History";
import { CameraPlaneSnap, ConstructionPlaneSnap, PlaneSnap } from "../../editor/snaps/Snap";
import * as visual from "../../editor/VisualModel";
import { HighlightManager } from "../../selection/HighlightManager";
import * as selector from '../../selection/ViewportSelector';
import { ViewportSelector } from '../../selection/ViewportSelector';
import { Helpers } from "../../util/Helpers";
import { Pane } from '../pane/Pane';
import { GridHelper } from "./GridHelper";
import { OutlinePass } from "./OutlinePass";

import { Orientation, ViewportNavigator, ViewportNavigatorPass } from "./ViewportHelper";

const near = 0.01;
const far = 10000;
const frustumSize = 20;

export interface EditorLike extends selector.EditorLike {
    db: DatabaseLike,
    helpers: Helpers,
    viewports: Viewport[],
    signals: EditorSignals,
    originator: EditorOriginator,
    windowLoaded: boolean,
    highlighter: HighlightManager,
}

export class Viewport {
    readonly composer: EffectComposer;
    readonly outlinePassSelection: OutlinePass;
    readonly outlinePassHover: OutlinePass;
    readonly phantomsPass: RenderPass;
    readonly helpersPass: RenderPass;
    readonly selector = new ViewportSelector(this.camera, this.renderer.domElement, this.editor);
    lastPointerEvent?: PointerEvent;
    private readonly disposable = new CompositeDisposable();

    private readonly scene = new THREE.Scene();
    private readonly phantomsScene = new THREE.Scene();
    private readonly helpersScene = new THREE.Scene();

    private navigator = new ViewportNavigator(this.navigationControls, this.domElement, 128);

    constructor(
        private readonly editor: EditorLike,
        readonly renderer: THREE.WebGLRenderer,
        readonly domElement: HTMLElement,
        readonly camera: THREE.Camera,
        constructionPlane: PlaneSnap,
        readonly navigationControls: OrbitControls,
        readonly grid: GridHelper,
    ) {
        this.constructionPlane = constructionPlane;
        const rendererDomElement = this.renderer.domElement;

        rendererDomElement.addEventListener('pointermove', e => {
            this.lastPointerEvent = e;
        });

        this.renderer.setPixelRatio(window.devicePixelRatio);
        const size = this.renderer.getSize(new THREE.Vector2());
        const renderTarget = new THREE.WebGLMultisampleRenderTarget(size.width, size.height, { type: THREE.FloatType });
        renderTarget.samples = 8;

        EffectComposer: {
            this.composer = new EffectComposer(this.renderer, renderTarget);
            this.composer.setPixelRatio(window.devicePixelRatio);

            const renderPass = new RenderPass(this.scene, this.camera);
            this.phantomsPass = new RenderPass(this.phantomsScene, this.camera);
            this.helpersPass = new RenderPass(this.helpersScene, this.camera);
            const copyPass = new ShaderPass(CopyShader);

            this.phantomsPass.clear = false;
            this.phantomsPass.clearDepth = true;
            this.helpersPass.clear = false;
            this.helpersPass.clearDepth = true;

            const outlinePassSelection = new OutlinePass(new THREE.Vector2(this.offsetWidth, this.offsetHeight), editor.db.scene, this.camera);
            outlinePassSelection.edgeStrength = 3;
            outlinePassSelection.edgeGlow = 0;
            outlinePassSelection.edgeThickness = 1;
            outlinePassSelection.visibleEdgeColor.setHex(0xfffff00);
            outlinePassSelection.hiddenEdgeColor.setHex(0xfffff00);
            outlinePassSelection.downSampleRatio = 1;
            this.outlinePassSelection = outlinePassSelection;

            const outlinePassHover = new OutlinePass(new THREE.Vector2(this.offsetWidth, this.offsetHeight), editor.db.scene, this.camera);
            outlinePassHover.edgeStrength = 3;
            outlinePassHover.edgeGlow = 0;
            outlinePassHover.edgeThickness = 1;
            outlinePassHover.visibleEdgeColor.setHex(0xfffffff);
            outlinePassHover.hiddenEdgeColor.setHex(0xfffffff);
            outlinePassHover.downSampleRatio = 1;
            this.outlinePassHover = outlinePassHover;

            const navigatorPass = new ViewportNavigatorPass(this.navigator, this.camera);

            const gammaCorrection = new ShaderPass(GammaCorrectionShader);

            this.composer.addPass(renderPass);
            this.composer.addPass(this.outlinePassHover);
            this.composer.addPass(this.outlinePassSelection);
            this.composer.addPass(this.phantomsPass);
            this.composer.addPass(this.helpersPass);
            this.composer.addPass(navigatorPass);
            this.composer.addPass(gammaCorrection);
        }

        this.render = this.render.bind(this);
        this.setNeedsRender = this.setNeedsRender.bind(this);
        this.outlineSelection = this.outlineSelection.bind(this);
        this.outlineHover = this.outlineHover.bind(this);
        this.navigationStart = this.navigationStart.bind(this);
        this.navigationEnd = this.navigationEnd.bind(this);
        this.navigationChange = this.navigationChange.bind(this);
        this.selectionStart = this.selectionStart.bind(this);
        this.selectionEnd = this.selectionEnd.bind(this);

        this.disposable.add(
            this.editor.registry.add(this.domElement, {
                'viewport:front': () => this.navigate(Orientation.negY),
                'viewport:right': () => this.navigate(Orientation.posX),
                'viewport:top': () => this.navigate(Orientation.posZ),
            })
        );

        this.disposable.add(new Disposable(() => {
            this.selector.dispose();
            this.navigationControls.dispose();
        }));

        this.scene.background = new THREE.Color(0x424242).convertGammaToLinear();
    }

    private started = false;
    start() {
        if (this.started) return;

        this.editor.signals.selectionChanged.add(this.outlineSelection);
        this.editor.signals.historyChanged.add(this.outlineSelection);
        this.editor.signals.objectHovered.add(this.outlineHover);
        this.editor.signals.objectUnhovered.add(this.outlineHover);

        this.editor.signals.selectionChanged.add(this.setNeedsRender);
        this.editor.signals.sceneGraphChanged.add(this.setNeedsRender);
        this.editor.signals.factoryUpdated.add(this.setNeedsRender);
        this.editor.signals.factoryCancelled.add(this.setNeedsRender);
        this.editor.signals.pointPickerChanged.add(this.setNeedsRender);
        this.editor.signals.gizmoChanged.add(this.setNeedsRender);
        this.editor.signals.objectHovered.add(this.setNeedsRender);
        this.editor.signals.objectUnhovered.add(this.setNeedsRender);
        this.editor.signals.objectAdded.add(this.setNeedsRender);
        this.editor.signals.historyChanged.add(this.setNeedsRender);
        this.editor.signals.commandEnded.add(this.setNeedsRender);
        this.editor.signals.moduleReloaded.add(this.setNeedsRender);

        this.navigationControls.addEventListener('change', this.setNeedsRender);
        this.navigationControls.addEventListener('start', this.navigationStart);

        this.selector.addEventListener('start', this.selectionStart);
        this.selector.addEventListener('end', this.selectionEnd);

        this.started = true;
        this.render(-1);

        this.disposable.add(new Disposable(() => {
            this.editor.signals.selectionChanged.remove(this.outlineSelection);
            this.editor.signals.historyChanged.remove(this.outlineSelection);
            this.editor.signals.objectHovered.remove(this.outlineHover);

            this.editor.signals.selectionChanged.remove(this.setNeedsRender);
            this.editor.signals.sceneGraphChanged.remove(this.setNeedsRender);
            this.editor.signals.factoryUpdated.remove(this.setNeedsRender);
            this.editor.signals.factoryCancelled.remove(this.setNeedsRender);
            this.editor.signals.pointPickerChanged.remove(this.setNeedsRender);
            this.editor.signals.gizmoChanged.remove(this.setNeedsRender);
            this.editor.signals.objectHovered.remove(this.setNeedsRender);
            this.editor.signals.objectUnhovered.remove(this.setNeedsRender);
            this.editor.signals.objectAdded.remove(this.setNeedsRender);
            this.editor.signals.historyChanged.remove(this.setNeedsRender);
            this.editor.signals.moduleReloaded.remove(this.setNeedsRender);

            this.navigationControls.removeEventListener('change', this.setNeedsRender);
            this.navigationControls.removeEventListener('start', this.navigationStart);
            this.selector.removeEventListener('start', this.selectionStart);
            this.selector.removeEventListener('end', this.selectionEnd);

            this.started = false;
        }));
    }

    private needsRender = true;
    private setNeedsRender() {
        this.needsRender = true;
    }

    lastFrameNumber = -1;

    render(frameNumber: number) {
        if (!this.started) return;
        requestAnimationFrame(this.render);
        if (!this.needsRender) return;

        const { editor: { db, helpers, signals }, scene, phantomsScene, helpersScene, grid, composer, camera, lastFrameNumber, offsetWidth, offsetHeight, phantomsPass, helpersPass } = this

        try {
            // prepare the scene, once per frame:
            if (frameNumber > lastFrameNumber) {
                db.rebuildScene();
                scene.add(helpers.axes);
                scene.add(db.scene);
                if (grid) {
                    scene.add(grid);
                    grid.update(camera);
                }
                helpersScene.add(helpers.scene);
                phantomsScene.add(db.phantomObjects);
                phantomsPass.enabled = db.phantomObjects.children.length > 0;
                helpersPass.enabled = helpers.scene.children.length > 0;
            }

            const resolution = new THREE.Vector2(offsetWidth, offsetHeight);
            signals.renderPrepared.dispatch({ camera, resolution });

            composer.render();

            if (frameNumber > lastFrameNumber) {
                scene.clear();
                helpersScene.clear();
                phantomsScene.clear();
            }
        } finally {
            this.needsRender = false;
            this.lastFrameNumber = frameNumber;
        }
    }

    outlineSelection() {
        const selection = this.editor.highlighter.outlineSelection;
        const toOutline = [...selection].flatMap(item => item.outline);
        this.outlinePassSelection.selectedObjects = toOutline;
    }

    outlineHover() {
        const hover = this.editor.highlighter.outlineHover;
        const toOutline = [...hover].flatMap(item => item.outline);
        this.outlinePassHover.selectedObjects = toOutline;
    }

    private offsetWidth: number = 100;
    private offsetHeight: number = 100;

    setSize(offsetWidth: number, offsetHeight: number) {
        this.offsetWidth = offsetWidth;
        this.offsetHeight = offsetHeight;

        const { camera } = this;
        const aspect = offsetWidth / offsetHeight;
        if (camera instanceof THREE.PerspectiveCamera) {
            camera.aspect = aspect;
        } else if (camera instanceof THREE.OrthographicCamera) {
            camera.left = frustumSize * aspect / - 2;
            camera.right = frustumSize * aspect / 2;
        } else throw new Error("Invalid camera");
        camera.near = near;
        camera.far = far;
        camera.updateProjectionMatrix();

        this.renderer.setSize(offsetWidth, offsetHeight);
        this.composer.setSize(offsetWidth, offsetHeight);
        this.outlinePassHover.setSize(offsetWidth, offsetHeight);
        this.outlinePassSelection.setSize(offsetWidth, offsetHeight);
        this.setNeedsRender();
    }

    disableControls() {
        this.selector.enabled = this.navigationControls.enabled = false;
    }

    enableControls() {
        this.selector.enabled = this.navigationControls.enabled = true;
    }

    private navigationState: NavigationState = { tag: 'none' }

    private navigationStart() {
        this.navigationControls.addEventListener('change', this.navigationChange);
        this.navigationControls.addEventListener('end', this.navigationEnd);
        this.navigationState = { tag: 'navigating', selectorEnabled: this.selector.enabled };
        this.selector.enabled = false;
        this.editor.signals.viewportActivated.dispatch(this);
    }

    private navigationChange() {
        this.constructionPlane.update(this.camera);
    }

    private navigationEnd() {
        switch (this.navigationState.tag) {
            case 'navigating':
                this.navigationControls.removeEventListener('change', this.navigationChange);
                this.navigationControls.removeEventListener('end', this.navigationEnd);
                this.selector.enabled = this.navigationState.selectorEnabled;
                this.navigationState = { tag: 'none' };
                break;
            default: throw new Error("invalid state");
        }
    }

    private selectionStart() {
        this.editor.signals.viewportActivated.dispatch(this);
    }

    private selectionEnd() { }

    dispose() {
        this.disposable.dispose();
    }

    private _constructionPlane!: PlaneSnap;
    get constructionPlane() { return this._constructionPlane }
    set constructionPlane(plane: PlaneSnap) {
        this._constructionPlane = plane;
        this.grid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), plane.n);
        this.setNeedsRender();
        if (this.constructionPlane instanceof CameraPlaneSnap) {
            this.grid.visible = false;
        } else {
            this.grid.visible = true;
        }
    }

    toggleConstructionPlane() {
        if (this.constructionPlane instanceof CameraPlaneSnap) {
            this.constructionPlane = new ConstructionPlaneSnap(new THREE.Vector3(0, 0, 1));
        } else {
            this.constructionPlane = new CameraPlaneSnap(this.camera);
        }
    }

    navigate(to: Orientation) {
        const n = this.navigator.prepareAnimationData(to);
        const constructionPlane = new PlaneSnap(n);
        this.constructionPlane = constructionPlane;
    }

    get isOrtho(): boolean {
        return false;
    }
}

type NavigationState = { tag: 'none' } | { tag: 'navigating', selectorEnabled: boolean }

export interface ViewportElement {
    readonly model: Viewport;
}

export default (editor: EditorLike) => {
    class ViewportElement extends HTMLElement implements ViewportElement {
        readonly model: Viewport;

        constructor() {
            super();

            const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });

            const gridColor = new THREE.Color(0x666666).convertGammaToLinear();
            const grid = new GridHelper(300, 300, gridColor, gridColor);

            this.append(renderer.domElement);

            const view = this.getAttribute("view");
            const orthographicCamera = new THREE.OrthographicCamera(-frustumSize / 2, frustumSize / 2, frustumSize / 2, -frustumSize / 2, 0, far);
            orthographicCamera.zoom = 3;
            const perspectiveCamera = new THREE.PerspectiveCamera(frustumSize, 1, near, far);

            let camera: THREE.Camera;
            let n: THREE.Vector3;
            let enableRotate = false;
            switch (view) {
                case "3d":
                    camera = orthographicCamera;
                    camera.position.set(100, -100, 100);
                    n = new THREE.Vector3(0, 0, 1);
                    enableRotate = true;
                    break;
                case "top":
                    camera = orthographicCamera;
                    camera.position.set(0, 0, 10);
                    n = new THREE.Vector3(0, 0, 1);
                    break;
                case "right":
                    camera = orthographicCamera;
                    camera.position.set(10, 0, 0);
                    n = new THREE.Vector3(1, 0, 0);
                    break;
                case "front":
                default:
                    camera = orthographicCamera;
                    camera.position.set(0, 10, 0);
                    n = new THREE.Vector3(0, 1, 0);
                    break;
            }
            camera.layers = visual.VisibleLayers;

            const navigationControls = new OrbitControls(camera, renderer.domElement);
            navigationControls.enableRotate = enableRotate;
            navigationControls.mouseButtons = {
                // @ts-expect-error
                LEFT: undefined,
                MIDDLE: THREE.MOUSE.ROTATE,
                RIGHT: THREE.MOUSE.PAN
            };

            camera.up.set(0, 0, 1);
            camera.lookAt(new THREE.Vector3());
            camera.updateMatrixWorld();

            const constructionPlane = new PlaneSnap(n);

            this.model = new Viewport(
                editor,
                renderer,
                this,
                camera,
                constructionPlane,
                navigationControls,
                grid,
            );

            this.resize = this.resize.bind(this);
        }

        connectedCallback() {
            editor.viewports.push(this.model);

            const pane = this.parentElement as Pane;
            pane.signals.flexScaleChanged.add(this.resize);
            editor.signals.windowLoaded.add(this.resize);
            editor.signals.windowResized.add(this.resize);

            if (editor.windowLoaded) this.model.start();
        }

        disconnectedCallback() {
            this.model.dispose();
        }

        resize() {
            this.model.start();
            this.model.setSize(this.offsetWidth, this.offsetHeight);
        }
    }

    customElements.define('ispace-viewport', ViewportElement);
}