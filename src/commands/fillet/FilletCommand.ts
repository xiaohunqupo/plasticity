import * as THREE from "three";
import { Mode } from "../../command/AbstractGizmo";
import Command from "../../command/Command";
import { ObjectPicker } from "../../command/ObjectPicker";
import { PointPicker } from "../../command/PointPicker";
import { Quasimode } from "../../command/Quasimode";
import { SelectionMode } from "../../selection/ChangeSelectionExecutor";
import * as visual from "../../visual_model/VisualModel";
import { FilletDialog } from "./FilletDialog";
import { MultiFilletFactory } from './FilletFactory';
import { FilletSolidGizmo } from './FilletGizmo';
import { ChamferAndFilletKeyboardGizmo } from "./FilletKeyboardGizmo";

export class FilletSolidCommand extends Command {
    point?: THREE.Vector3;

    async execute(): Promise<void> {
        const fillet = new MultiFilletFactory(this.editor.db, this.editor.materials, this.editor.signals).resource(this);

        const gizmo = new FilletSolidGizmo(fillet, this.editor, this.point);
        const keyboard = new ChamferAndFilletKeyboardGizmo(this.editor);
        const dialog = new FilletDialog(fillet, this.editor.signals);

        dialog.execute(async (params) => {
            gizmo.toggle(fillet.mode);
            keyboard.toggle(fillet.mode);
            gizmo.render(params.distance1);
            await fillet.update();
        }).resource(this).then(() => this.finish(), () => this.cancel());

        const objectPicker = new ObjectPicker(this.editor, undefined, 'viewport-selector');
        const revert = this.editor.highlighter.useTemporary(objectPicker.selection);
        this.ensure(() => revert.dispose());

        objectPicker.mode.set(SelectionMode.CurveEdge);
        objectPicker.copy(this.editor.selection);

        const edges = await objectPicker.slice(SelectionMode.CurveEdge, 1, Number.MAX_SAFE_INTEGER).resource(this);
        fillet.edges = [...edges];
        // fillet.start(); // FIXME:

        const variable = new PointPicker(this.editor);
        const restriction = variable.restrictToEdges(fillet.edges); // FIXME:
        variable.raycasterParams.Line2.threshold = 300;
        variable.raycasterParams.Points.threshold = 50;
        keyboard.execute(async (s) => {
            switch (s) {
                case 'add':
                    const { point } = await variable.execute().resource(this);
                    const { model, view } = restriction.match;
                    const t = restriction.match.t(point);
                    const fn = fillet.functions.get(view.simpleName)!;
                    const added = gizmo.addVariable(point, model, t);
                    added.execute(async (delta) => {
                        fn.InsertValue(t, delta);
                        await fillet.update();
                    }, Mode.Persistent).resource(this);
                    break;
            }
        }).resource(this);

        gizmo.execute(async (params) => {
            keyboard.toggle(fillet.mode);
            gizmo.toggle(fillet.mode);
            dialog.toggle(fillet.mode);
            dialog.render();
            await fillet.update();
        }).resource(this);
        gizmo.showEdges();

        this.factoryChanged.addOnce(() => {
            const quasiPicker = new ObjectPicker(this.editor, objectPicker.selection, 'viewport-selector[quasimode]');
            const quasimode = new Quasimode("modify-selection", this.editor, fillet, quasiPicker);
            quasiPicker.mode.set(SelectionMode.CurveEdge);
            quasimode.execute(selection => {
                fillet.edges = [...selection.edges];
                gizmo.showEdges();
            }, 1, Number.MAX_SAFE_INTEGER).resource(this);
        })

        if (this.agent == 'user') {
            const task = objectPicker.execute(selection => {
                fillet.edges = [...selection.edges];
                gizmo.showEdges();
            }, 1, Number.MAX_SAFE_INTEGER).resource(this);
            this.factoryChanged.addOnce(() => task.finish());
        }

        await this.finished;

        const results = await fillet.commit() as visual.Solid[];
        this.editor.selection.selected.add(results);
    }
}
