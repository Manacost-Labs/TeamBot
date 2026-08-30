export function createPreparedChannelController<T extends { id: string }>(
  create: (agentId: string) => Promise<T>,
) {
  let prepared: { agentId: string; channel: Promise<T> } | null = null;

  return {
    prepare(agentId: string): Promise<T> {
      if (prepared?.agentId === agentId) return prepared.channel;
      const channel = create(agentId).catch((error) => {
        if (prepared?.channel === channel) prepared = null;
        throw error;
      });
      prepared = { agentId, channel };
      return channel;
    },
    clear(): void {
      prepared = null;
    },
  };
}

/** Stash/navigation starts synchronously; ownership must transfer before that navigation unmounts. */
export async function finishWithCommittedAttachments(
  finish: () => Promise<void>,
  commit: () => void,
): Promise<void> {
  const navigation = finish();
  commit();
  await navigation;
}
