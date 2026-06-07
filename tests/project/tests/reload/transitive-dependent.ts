import { Node } from "godot";
import { getBaseValue } from "./transitive-base";

export default class TransitiveDependent extends Node {
    getCombined(): number {
        return getBaseValue() + 1;
    }
}
