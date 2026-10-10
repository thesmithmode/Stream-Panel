<script lang="ts">
  import { groupCollectionGaps, gapReasonLabel, type CollectionGap } from './collection-gaps';
  let { gaps }: { gaps: CollectionGap[] } = $props();
  const groups = $derived(groupCollectionGaps(gaps));
  const date = (ms: number) => new Date(ms).toLocaleString('ru-RU');
</script>

{#if groups.length}
  <section aria-label="Пропуски сбора" class="collection-gaps">
    <h3>Пропуски сбора</h3>
    {#each groups as group}
      <details>
        <summary>
          <span>{group.source}: {gapReasonLabel(group.reason)}</span>
          <small>Интервалов: {group.intervals.length}</small>
        </summary>
        <ul>
          {#each group.intervals as gap}
            <li><time>{date(gap.started_at_ms)}</time> — {gap.ended_at_ms == null ? 'Окончание не установлено' : date(gap.ended_at_ms)}</li>
          {/each}
        </ul>
      </details>
    {/each}
  </section>
{/if}

<style>
  details { border-top: 1px solid var(--border); padding: .75rem 0; }
  summary { cursor: pointer; overflow-wrap: anywhere; }
  small { display: block; margin: .35rem 0 0 1rem; color: var(--muted); }
  ul { padding-left: 1.5rem; }
  li { margin: .5rem 0; overflow-wrap: anywhere; }
</style>
