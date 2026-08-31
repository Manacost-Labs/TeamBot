import { z } from "zod";

/**
 * Browser-side coworker form contract. Limits match the server parser so validation errors can be
 * shown next to fields before submit.
 */
export const agentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(80, "Name must be 80 characters or fewer."),
  title: z
    .string()
    .trim()
    .min(1, "Title is required.")
    .max(120, "Title must be 120 characters or fewer."),
  roleDescription: z
    .string()
    .trim()
    .min(1, "Role description is required.")
    .max(1000, "Role description must be 1000 characters or fewer."),
  avatarSeed: z
    .string()
    .trim()
    .max(80, "Avatar seed must be 80 characters or fewer."),
  visibility: z.enum(["public", "private"]),
  /**
   * The AG-UI endpoint this coworker runs on. Empty means the Bot in the box.
   *
   * Only URL shape is checked here; deployment allow/deny rules are server-side.
   */
  endpoint: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^https?:\/\/\S+$/.test(value),
      "Enter a web address starting with http:// or https://.",
    ),
  /**
   * A key the agent sits behind. WRITE-ONLY: it is never sent back from the server, so this field is
   * always empty when editing, and leaving it empty keeps whatever key is already set.
   */
  authValue: z.string(),
  model: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^[A-Za-z0-9._:-]{1,120}$/.test(value),
      "Use letters, numbers, dots, underscores, colons or hyphens.",
    ),
  reasoningEffort: z.enum([
    "",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "adaptive",
  ]),
  reasoningCeiling: z.enum(["low", "medium", "high", "xhigh"]),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

export const emptyAgentForm: AgentFormValues = {
  name: "",
  title: "",
  roleDescription: "",
  avatarSeed: "",
  visibility: "private",
  endpoint: "",
  authValue: "",
  model: "",
  reasoningEffort: "",
  reasoningCeiling: "high",
};

/** Convert form values to API input; omit an empty key so editing preserves the current credential. */
export function agentInputFrom(values: AgentFormValues) {
  return {
    name: values.name,
    title: values.title,
    roleDescription: values.roleDescription,
    ...(values.avatarSeed.trim()
      ? { avatarSeed: values.avatarSeed.trim() }
      : {}),
    visibility: values.visibility,
    endpoint: values.endpoint,
    model: values.model || null,
    reasoningEffort: values.reasoningEffort || null,
    reasoningCeiling:
      values.reasoningEffort === "adaptive" ? values.reasoningCeiling : null,
    ...(values.authValue.trim()
      ? { auth: { header: "Authorization", value: values.authValue.trim() } }
      : {}),
  };
}
