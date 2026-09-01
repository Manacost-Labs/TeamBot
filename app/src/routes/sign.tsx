import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { ProviderLogo } from "@/components/auth/provider-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  providerName,
  signInWith,
  signInWithEmailDomain,
} from "@/lib/auth/client";
import { appConfig } from "@/lib/generated/application-config";
import {
  type AuthProviderId,
  authProvidersQueryOptions,
  currentUserQueryOptions,
  telegramLoginState,
} from "../lib/auth/queries";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

export const Route = createFileRoute("/sign")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user) {
      throw redirect({ to: "/" });
    }
    // Loaded here so the screen paints with its buttons rather than painting empty and then
    // growing them, which reads as "no providers" for exactly as long as the request takes.
    await context.queryClient.ensureQueryData(authProvidersQueryOptions());
  },
  component: SignScreen,
});

const TELEGRAM_WIDGET_SOURCE = "https://telegram.org/js/telegram-widget.js?22";
const TELEGRAM_BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/;
const TELEGRAM_LOGIN_STATE = /^[a-f0-9]{64}$/;
const TELEGRAM_GENERIC_ERROR =
  "Не удалось выполнить вход через Telegram. Попробуйте ещё раз.";

/**
 * The official Telegram widget is a script, so it cannot be represented as ordinary JSX.
 *
 * Every value reaching its data attributes is bounded before the node exists. The script source,
 * callback path and callback origin are constants owned by this app; no HTML string is ever parsed.
 */
export function TelegramLoginWidget({
  botUsername,
  state,
  onError,
}: {
  botUsername: string;
  state: string;
  onError: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const errorHandlerRef = useRef(onError);

  useEffect(() => {
    errorHandlerRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (
      !TELEGRAM_BOT_USERNAME.test(botUsername) ||
      !TELEGRAM_LOGIN_STATE.test(state)
    ) {
      errorHandlerRef.current();
      return;
    }

    const callback = new URL(
      "/api/auth/telegram/callback",
      window.location.origin,
    );
    callback.searchParams.set("state", state);

    const script = document.createElement("script");
    script.src = TELEGRAM_WIDGET_SOURCE;
    script.async = true;
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "8");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-auth-url", callback.toString());
    const handleLoadFailure = () => errorHandlerRef.current();
    script.addEventListener("error", handleLoadFailure);
    container.replaceChildren(script);

    return () => {
      script.removeEventListener("error", handleLoadFailure);
      // The widget may have replaced the script with an iframe by now, so remove all children it
      // owns rather than only the original script node.
      container.replaceChildren();
    };
  }, [botUsername, state]);

  return <div className="flex min-h-10 justify-center" ref={containerRef} />;
}

export function SignScreen() {
  // Which provider is being opened, rather than whether one is: with three buttons, a single
  // boolean would put "Opening…" on all of them.
  const [opening, setOpening] = useState<AuthProviderId | "sso" | null>(null);
  const [error, setError] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("telegramError") === "1"
      ? TELEGRAM_GENERIC_ERROR
      : null,
  );
  const { data: options } = useQuery(authProvidersQueryOptions());
  const providers = options?.providers ?? [];
  const telegram = options?.telegram ?? null;
  const [telegramState, setTelegramState] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    value?: string;
  }>({ status: "idle" });
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (!telegram) {
      setTelegramState({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    setTelegramState({ status: "loading" });
    telegramLoginState(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setTelegramState({ status: "ready", value });
        }
      },
      (cause: unknown) => {
        if (
          controller.signal.aborted ||
          (cause instanceof DOMException && cause.name === "AbortError")
        )
          return;
        setTelegramState({ status: "error" });
        setError(
          "Не удалось подготовить вход через Telegram. Попробуйте ещё раз.",
        );
      },
    );
    return () => controller.abort();
  }, [telegram]);

  /**
   * Sign in through whichever identity provider covers this address.
   *
   * No password is asked for and none is checked here: only the part after the @ is used, to decide
   * which registered provider to hand somebody to.
   */
  async function handleDomainSignIn(submission: React.FormEvent) {
    submission.preventDefault();
    setError(null);
    setOpening("sso");

    try {
      await signInWithEmailDomain(email);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Для этого адреса не настроен способ входа.",
      );
      setOpening(null);
    }
  }

  async function handleSignIn(provider: AuthProviderId) {
    setError(null);
    setOpening(provider);

    try {
      await signInWith(provider);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `Не удалось начать вход через ${providerName(provider)}.`,
      );
      setOpening(null);
    }
  }

  const prefersReducedMotion = useReducedMotion();
  const hidden = {
    opacity: 0,
    ...(prefersReducedMotion ? {} : { transform: ENTRANCE_OFFSET }),
  };
  const shown = {
    opacity: 1,
    ...(prefersReducedMotion ? {} : { transform: "translateY(0px)" }),
  };

  return (
    <div className="flex flex-col h-dvh w-full items-center justify-center -mt-12">
      <motion.div
        animate="shown"
        className="flex-1 flex w-full max-w-82 flex-col items-center justify-center p-4"
        initial="hidden"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: ENTRANCE_STAGGER_SECONDS } },
        }}
      >
        <motion.div
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
          className="flex items-center justify-center"
        >
          <AgentOrb size="56px" />
        </motion.div>
        <motion.h1
          className="text-2xl font-medium tracking-tight text-center mt-8"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          Вход в {appConfig.brand.productName}
        </motion.h1>
        <motion.div
          className="mt-8 w-full"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {telegram ? (
            telegramState.status === "ready" && telegramState.value ? (
              <TelegramLoginWidget
                botUsername={telegram.botUsername}
                onError={() => setError(TELEGRAM_GENERIC_ERROR)}
                state={telegramState.value}
              />
            ) : telegramState.status === "loading" ? (
              <p
                className="text-center text-sm text-muted-foreground"
                role="status"
              >
                Готовим безопасный вход через Telegram…
              </p>
            ) : null
          ) : providers.length > 0 ? (
            <div className="flex flex-col gap-2">
              {providers.map((provider) => (
                /*
                 * Every provider gets the same button, and it is the light-themed outline one
                 * rather than the app's filled primary. Google's guidelines require their button be
                 * at least as prominent as any other sign-in option and specify its fill and
                 * stroke, so making one provider the loud one would break that for the others. The
                 * same size and weight throughout is also the honest presentation: a deployment
                 * that configured three has three, and none of them is the recommended one.
                 */
                <Button
                  className="h-10 w-full justify-start gap-3 px-3 tracking-tight"
                  disabled={opening !== null}
                  key={provider}
                  onClick={() => handleSignIn(provider)}
                  size="lg"
                  variant="outline"
                >
                  <ProviderLogo provider={provider} />
                  {/* Centred against the button, not against the space left of the mark. */}
                  <span className="flex-1 text-center">
                    {opening === provider
                      ? `Открываем ${providerName(provider)}…`
                      : `Продолжить через ${providerName(provider)}`}
                  </span>
                  {/* Balances the mark so the label sits in the middle of the button. */}
                  <span aria-hidden="true" className="size-[18px]" />
                </Button>
              ))}
            </div>
          ) : options?.sso ? null : (
            <p className="text-center text-sm text-muted-foreground">
              Для этого проекта не настроен способ входа.
            </p>
          )}
          {/*
           * The way in for a company that runs its own identity provider.
           *
           * Below the buttons, because a deployment with both has more people arriving through the
           * buttons: the registered providers are for the companies whose IdP was added by hand.
           */}
          {!telegram && options?.sso ? (
            <form className="mt-3" onSubmit={handleDomainSignIn}>
              {providers.length > 0 ? (
                <div className="mb-3 flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-muted-foreground text-xs">или</span>
                  <Separator className="flex-1" />
                </div>
              ) : null}
              <Input
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                required
                type="email"
                value={email}
              />
              <Button
                className="mt-2 h-10 w-full tracking-tight"
                disabled={opening !== null || email.trim().length === 0}
                size="lg"
                type="submit"
                variant="outline"
              >
                {opening === "sso"
                  ? "Открываем…"
                  : "Продолжить с корпоративной учётной записью"}
              </Button>
            </form>
          ) : null}
          {error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </motion.div>
      </motion.div>
    </div>
  );
}
