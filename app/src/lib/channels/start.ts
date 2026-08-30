import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import {
  stashFirstMessage,
  type UserMessageContent,
} from "@/components/channels/transcript-messages";
import { createChannelMutationOptions } from "./mutations";
import { createPreparedChannelController } from "./prepared-channel";
import { channelKeys } from "./queries";

/**
 * Start a channel from a just-submitted first message, then navigate there.
 *
 * Ordering matters: create, seed the channel cache, stash the first message, then navigate. That
 * keeps the first message visible while the channel thread joins.
 */
export function useStartChannel() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createChannel = useMutation(createChannelMutationOptions(queryClient));
  const createRef = useRef((agentId: string) =>
    createChannel.mutateAsync([agentId]),
  );
  createRef.current = (agentId) => createChannel.mutateAsync([agentId]);
  const preparedRef = useRef(
    createPreparedChannelController(async (agentId: string) => {
      const channel = await createRef.current(agentId);
      queryClient.setQueryData(channelKeys.detail(channel.id), channel);
      return channel;
    }),
  );

  const finish = async (
    channel: { id: string },
    content: UserMessageContent,
    messageId: string,
  ) => {
    stashFirstMessage(channel.id, content, messageId);
    await navigate({
      params: { channelId: channel.id },
      replace: true,
      to: "/channel/$channelId",
    });
  };

  return {
    pending: createChannel.isPending,
    prepare: (agentId: string) => preparedRef.current.prepare(agentId),
    finish,
  };
}
