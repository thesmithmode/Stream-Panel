<script lang="ts">
 let {items,value=$bindable(''),label,panelId}:{panelId:string;items:readonly (readonly [string,string])[];value?:string;label:string}=$props();
 const id=$props.id();
 function keydown(event:KeyboardEvent,index:number){let next=index;if(event.key==='ArrowRight')next=(index+1)%items.length;else if(event.key==='ArrowLeft')next=(index+items.length-1)%items.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=items.length-1;else return;event.preventDefault();value=items[next]![0];(event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();}
</script>
<div class="section-tabs" role="tablist" aria-label={label}>{#each items as [key,text],index}<button type="button" role="tab" id={`${id}-${key}`} aria-selected={value===key} aria-controls={panelId} tabindex={value===key?0:-1} class:active={value===key} onclick={()=>value=key} onkeydown={event=>keydown(event,index)}>{text}</button>{/each}</div>
