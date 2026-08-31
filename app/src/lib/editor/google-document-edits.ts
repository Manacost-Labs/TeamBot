import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

export type GoogleDocumentEdit = {
  id: string;
  state:
    | "pending"
    | "dispatching"
    | "succeeded"
    | "not_applied"
    | "ambiguous"
    | "expired"
    | "declined"
    | "superseded";
  botId: string;
  documentId: string;
  editCount: number;
  removedCharacters: number;
  insertedCharacters: number;
  expiresAt: string;
  edits: Array<{ position: number; before: string; after: string }>;
};

export const googleDocumentEditKey = (id: string) =>
  ["google-document-edit", id] as const;

export function googleDocumentEditQueryOptions(id: string) {
  return queryOptions({
    queryKey: googleDocumentEditKey(id),
    queryFn: (): Promise<GoogleDocumentEdit> =>
      client(`/api/editor/google-doc-edits/${encodeURIComponent(id)}`, "edit", {
        fallback: "Не удалось загрузить эту правку.",
      }),
    refetchInterval: (query) =>
      query.state.data?.state === "dispatching" ? 2_000 : false,
  });
}

export function decideGoogleDocumentEditMutationOptions(
  queryClient: QueryClient,
  id: string,
) {
  return mutationOptions({
    mutationFn: (
      decision: "approve" | "decline",
    ): Promise<GoogleDocumentEdit> =>
      client(
        `/api/editor/google-doc-edits/${encodeURIComponent(id)}/decision`,
        "edit",
        {
          method: "POST",
          body: { decision },
          fallback: "Не удалось сохранить решение.",
        },
      ),
    onSuccess: (edit) =>
      queryClient.setQueryData(googleDocumentEditKey(id), edit),
  });
}
