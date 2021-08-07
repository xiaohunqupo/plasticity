import { CompositeDisposable, Disposable } from 'event-kit';
import { render } from 'preact';
import _ from "underscore-plus";
import c3d from '../../../build/Release/c3d.node';
import { Editor } from '../../editor/Editor';
import { GeometryDatabase } from '../../editor/GeometryDatabase';
import * as visual from '../../editor/VisualModel';
import { HasSelection } from '../../selection/SelectionManager';

export class Model {
    constructor(
        private readonly selection: HasSelection,
        private readonly db: GeometryDatabase
    ) { }

    get item() {
        const { selection } = this;
        if (selection.selectedSolids.size == 0) throw new Error("invalid precondition");

        const solid = selection.selectedSolids.first;
        return solid;
    }

    get creators() {
        const { db, selection } = this;
        if (selection.selectedSolids.size == 0) return [];

        const result: [number, c3d.Creator][] = [];
        const solid = selection.selectedSolids.first!;
        const model = db.lookup(solid);
        for (let i = 0, l = model.GetCreatorsCount(); i < l; i++) {
            const creator = model.GetCreator(i)!;
            result.push([i, creator.Cast<c3d.Creator>(creator.IsA())]);
        }

        return result;
    }
}

export default (editor: Editor) => {
    class Modifiers extends HTMLElement {
        private readonly dispose = new CompositeDisposable();
        private readonly model = new Model(editor.selection, editor.db);

        constructor() {
            super();
            this.render = this.render.bind(this);
        }

        connectedCallback() {
            editor.signals.selectionChanged.add(this.render);
            this.dispose.add(new Disposable(() => editor.signals.selectionChanged.remove(this.render)));
            this.render();
        }

        render() {
            const result = <ol>
                {this.model.creators.map(([i, c]) => {
                    const Z = `ispace-creator-${_.dasherize(c3d.CreatorType[c.IsA()])}`;
                    // @ts-expect-error("not sure how to type this")
                    return <li><Z creator={c} index={i} item={this.model.item}></Z></li>
                })}
            </ol>;
            render(result, this);
        }

        disconnectedCallback() {
            this.dispose.dispose();
        }
    }
    customElements.define('ispace-modifiers', Modifiers);

    class Creator<C extends c3d.Creator, T> extends HTMLElement {
        constructor() {
            super();
            this.render = this.render.bind(this);
        }

        private _index!: number;
        set index(index: number) { this._index = index }
        get index() { return this._index }

        private _creator!: c3d.Creator;
        get creator() { return this._creator }
        set creator(p: c3d.Creator) { this._creator = p }

        private _item!: visual.Item;
        get item() { return this._item }
        set item(item: visual.Item) { this._item = item }

        connectedCallback() { this.render() }

        render() {
            render(
                <div class="header">
                    <input type="checkbox" />
                    <div class="name">{c3d.CreatorType[this.creator.IsA()]}</div>
                </div>, this);
        }
    }
    customElements.define('ispace-creator', Creator);

    for (const key in c3d.CreatorType) {
        class Foo extends Creator<any, any> { };
        customElements.define(`ispace-creator-${_.dasherize(key)}`, Foo);
    }
}
