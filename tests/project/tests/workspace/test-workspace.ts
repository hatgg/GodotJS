import { Node } from "godot";
import { wsValue } from "myws";
import { reportTestFailure } from "../test-status";

export default class TestWorkspace extends Node {
    _ready() {
        try {
            const v = wsValue();
            if (v !== 42) {
                throw new Error(`expected wsValue() === 42, got ${v}`);
            }
            console.log("Workspace: ok");
        } catch (err) {
            reportTestFailure("workspace", err);
        }
    }
}
