type Request={title:string;message:string;confirmLabel:string;resolve:(accepted:boolean)=>void};
export const confirmation=$state<{request:Request|null}>({request:null});
export function confirmAction(title:string,message:string,confirmLabel='Подтвердить'):Promise<boolean>{
 if(confirmation.request)return Promise.resolve(false);
 return new Promise(resolve=>{confirmation.request={title,message,confirmLabel,resolve};});
}
export function answerConfirmation(accepted:boolean){
 const request=confirmation.request;confirmation.request=null;request?.resolve(accepted);
}
