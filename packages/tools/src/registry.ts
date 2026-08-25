import type { AnyToolDefinition } from "./contract.js";

export class ToolRegistry {
  readonly #definitions: ReadonlyMap<string, AnyToolDefinition>;

  constructor(definitions: readonly AnyToolDefinition[]) {
    const entries = definitions.map((definition) => [definition.name, definition] as const);
    if (new Set(entries.map(([name]) => name)).size !== entries.length) {
      throw new Error("Tool names must be unique");
    }
    this.#definitions = new Map(entries);
    Object.freeze(this);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.#definitions.get(name);
  }

  names(): readonly string[] {
    return Object.freeze([...this.#definitions.keys()].sort());
  }

  resolve(grantedNames: ReadonlySet<string>): readonly AnyToolDefinition[] {
    return Object.freeze(
      [...grantedNames]
        .sort()
        .map((name) => this.#definitions.get(name))
        .filter((definition): definition is AnyToolDefinition => definition !== undefined)
    );
  }
}
