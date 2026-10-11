import "i18next";
import type { Resources } from "./resources";

declare module "i18next" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: Resources;
  }
}
