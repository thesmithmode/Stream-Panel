<script lang="ts">
  import { onMount, tick } from "svelte";

  let { label, text, id }: { label: string; text: string; id: string } = $props();
  let open = $state(false);
  let root = $state<HTMLDivElement | undefined>();
  let popup = $state<HTMLDivElement | undefined>();
  let left = $state(0);
  let top = $state(0);

  async function showPopover() {
    open = true;
    await tick();
    if (!open) return;
    const trigger = root?.querySelector("button");
    if (!trigger || !popup) return;
    const anchor = trigger.getBoundingClientRect();
    const box = popup.getBoundingClientRect();
    const margin = 8;
    left = Math.max(margin, Math.min(anchor.left, window.innerWidth - box.width - margin));
    const below = anchor.bottom + margin;
    const above = anchor.top - box.height - margin;
    top = below + box.height <= window.innerHeight - margin
      ? below
      : above >= margin
        ? above
        : Math.max(margin, Math.min(below, window.innerHeight - box.height - margin));
  }

  function closePopover(restoreFocus = false) {
    open = false;
    if (restoreFocus) root?.querySelector("button")?.focus();
  }

  async function togglePopover() {
    if (open) closePopover();
    else await showPopover();
  }

  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (open && root && !root.contains(event.target as Node)) closePopover();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) closePopover(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  });
</script>

<div class="help" bind:this={root}>
  <button
    class="help-button"
    type="button"
    aria-label={label}
    aria-expanded={open}
    aria-controls={id}
    onclick={togglePopover}
  >?</button>
  {#if open}<div
      class="help-popover"
      id={id}
      role="dialog"
      aria-label={label}
      bind:this={popup}
      style={`top:${top}px;left:${left}px`}
    >
      {text}
    </div>{/if}
</div>

<style>
  .help {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
    vertical-align: middle;
  }

  .help-button {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--surface);
    color: var(--accent);
    cursor: pointer;
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
  }

  .help-popover {
    position: fixed;
    z-index: 20;
    width: min(280px, calc(100vw - 32px));
    max-height: calc(100vh - 16px);
    max-height: calc(100dvh - 16px);
    overflow: auto;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface, #161923);
    color: #f3f3f7;
    box-shadow: 0 12px 32px #0009;
    font-size: 13px;
    line-height: 1.5;
  }
</style>
