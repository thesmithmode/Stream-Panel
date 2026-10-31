/** Provider lists lag chat. Require five minutes of empty replies before suspecting a gap. */
export class ChatterHealth {
  private emptySince:number|null=null;
  private lastChat:number|null=null;
  private lastRecovery=-Infinity;
  message(at:number){this.lastChat=Math.max(this.lastChat??0,at);}
  empty(at:number){if(this.emptySince===null)this.emptySince=at;}
  populated(){this.emptySince=null;}
  suspect(at:number){return this.emptySince!==null&&at-this.emptySince>=300000&&this.lastChat!==null&&this.lastChat>=this.emptySince&&this.lastChat<=at&&at-this.lastChat<=180000;}
  recover(at:number){if(!this.suspect(at)||at-this.lastRecovery<300000)return false;this.lastRecovery=at;return true;}
}
