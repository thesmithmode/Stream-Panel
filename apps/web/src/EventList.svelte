<script lang="ts">
  import { date, money, type Event } from "./api";
  import { isAudioDonation, audioUrl } from "./labels";
  let {
    events,
    onPerson,
  }: { events: Event[]; onPerson?: (id: string) => void } = $props();
  const labels: Record<string, string> = {
    "chat.message": "Сообщение",
    donation: "Донат",
    bits: "Bits",
    follow: "Подписка на канал",
    subscription: "Платная подписка",
    "subscription.gift": "Подарочные подписки",
    raid: "Рейд",
    "stream.online": "Начало эфира",
    "stream.offline": "Конец эфира",
    "channel_points_custom_reward_redemption.add":"Награда за баллы",
    "channel_points_custom_reward_redemption.update":"Статус награды",
    "channel_points_automatic_reward_redemption.add":"Награда Twitch за баллы",
  };
</script>

<div class="event-list">
  {#each events as event (event.id)}
    <article class="event-row">
      <div class:donation={event.type === "donation"} class="event-symbol">
        {event.type === "donation" ? "DA" : "TW"}
      </div>
      <div class="event-body">
        <div class="event-title">
          <button
            class="text-button"
            onclick={() => event.person_id && onPerson?.(event.person_id)}
            disabled={!event.person_id}
            >{event.payload.actorName ||
              event.display_name ||
              "Событие канала"}</button
          ><span class="small muted">{labels[event.type] || event.type}</span
          >{#if event.payload.amountMinor && event.payload.currency}<strong
              class="teal"
              >{money(
                event.payload.amountMinor,
                event.payload.currency,
              )}</strong
            >{/if}
        </div>
        <p>
          {#if event.payload.redacted}
            <span class="muted">[скрыто модерацией]</span>
          {:else if isAudioDonation(event.payload)}
            <span class="audio-donation">
              <span class="audio-label">Аудио</span>
              {#if audioUrl(event.payload)}
                <audio
                  controls
                  preload="none"
                  src={audioUrl(event.payload)!}
                  aria-label="Аудио-донат"
                ></audio>
              {/if}
            </span>
          {:else}
            {event.payload.text || "—"}
          {/if}
        </p>
        <time class="small muted"
          >{date(event.occurred_at_ms)}{#if event.occurred_at_ms === null}
            · получено {date(event.received_at_ms)}{/if}</time
        >
      </div>
    </article>
  {/each}
</div>
