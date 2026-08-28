import { defineRuntime } from "polici/runtime-sdk";
import plugin from "./plugin.ts";

export default defineRuntime(plugin, {
  resolvers: {
    user(context, { login }) {
      return context.value.entity(
        "example:User",
        { namespace: "example:user", value: login },
        {
          id: context.value.id("example:user", login),
          login,
          groups: new Set(),
        },
      );
    },
    health(context) {
      return context.core.check("example-health", "passed");
    },
    "user.groups"() {
      return new Set(["users"]);
    },
  },
});
