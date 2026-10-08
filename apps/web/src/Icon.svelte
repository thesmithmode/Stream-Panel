<script lang="ts">
  let { name, size = 20 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    analytics: "M3 21V3m0 18h18M7 16l4-6 4 3 5-8",
    youtube: "M3 5h18v14H3Zm7 4 6 3-6 3Z",
    overview: "M3 10 12 3l9 7v11h-6v-7H9v7H3Z",
    sessions: "M5 21V10m7 11V3m7 18V7",
    people:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    connections:
      "M10 13a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l1.5-1.5",
    chat: "M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z",
    heart:
      "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z",
    record: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M9 9h6v6H9Z",
    arrow: "m9 5 7 7-7 7",
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name] || paths.chat} /></svg
>
