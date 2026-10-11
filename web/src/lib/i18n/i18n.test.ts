import en from "@/locales/en";
import fr from "@/locales/fr";

const resources = { en, fr };

type Tree = Record<string, unknown>;

function keys(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    value && typeof value === "object"
      ? keys(value as Tree, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? "").sort();
}

function lookup(tree: Tree, path: string): unknown {
  return path.split(".").reduce<unknown>((node, part) => (node as Tree | undefined)?.[part], tree);
}

describe("translations", () => {
  for (const ns of Object.keys(resources.en) as (keyof typeof resources.en)[]) {
    it(`fr/${ns} has exactly the same keys as en/${ns}`, () => {
      const en = keys(resources.en[ns]);
      const fr = keys(resources.fr[ns]);
      expect(fr.sort()).toEqual(en.sort());
    });

    it(`fr/${ns} keeps every interpolation placeholder`, () => {
      for (const key of keys(resources.en[ns])) {
        const enText = String(lookup(resources.en[ns], key));
        const frText = String(lookup(resources.fr[ns], key));
        expect({ key, placeholders: placeholders(frText) }).toEqual({
          key,
          placeholders: placeholders(enText),
        });
      }
    });
  }
});
