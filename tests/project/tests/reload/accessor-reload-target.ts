import { Node, Variant } from "godot";
import { createClassBinder } from "godot.annotations";

const bind = createClassBinder();

@bind()
export default class AccessorReloadTarget extends Node {
    @bind.export(Variant.Type.TYPE_STRING)
    accessor label!: string;

    getSentinel(): number {
        return 1;
    }
}
