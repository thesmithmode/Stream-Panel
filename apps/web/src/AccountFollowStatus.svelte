<script lang="ts">
 import {date} from './api';
 import type {FollowState} from '../../../packages/core/src/following';
 let {row}:{row?:FollowState|undefined}=$props();
 const history=$derived(row?.history.filter(item=>item.status!==null)??[]);
</script>
{#if row&&row.status!==null}
 <span class="follow-status" title={row.followedAtMs===null?undefined:`Дата подписки: ${date(row.followedAtMs)}`}>{row.status?'Подписан':'Не подписан'}</span>
 {#if history.length}<details class="follow-history"><summary>История подписки ({history.length})</summary><ul>{#each [...history].reverse() as item}<li><time>{date(item.at)}</time> · {item.status?'Подписан':'Не подписан'}</li>{/each}</ul></details>{/if}
{/if}
<style>
 .follow-status{font-size:12px;color:var(--muted);font-weight:400}.follow-history{font-size:11px;color:var(--muted);grid-column:1/-1}.follow-history summary{cursor:pointer;padding:4px 0;min-height:28px}.follow-history ul{padding:0;margin:2px 0 8px;list-style:none;max-height:180px;overflow:auto}.follow-history li{padding:3px 0;overflow-wrap:anywhere}
</style>
