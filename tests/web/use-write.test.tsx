// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,expect,test,vi } from 'vitest';
import { ToastProvider } from '../../web/src/components/toast.tsx';
import { useWrite } from '../../web/src/use-write.ts';
afterEach(cleanup);
function Action({send,reload}:{send:()=>Promise<unknown>;reload:()=>void}) {const {fire}=useWrite(reload);return <button onClick={()=>void fire(send)}>保存</button>;}
test('a structural operation confirms that project-wide curation is queued',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const reload=vi.fn();
 render(<ToastProvider><Action send={async()=>({project_review_queued:true})} reload={reload}/></ToastProvider>);
 fireEvent.click(screen.getByRole('button',{name:'保存'}));
 expect(await screen.findByText('已保存，项目重新整理已排队')).toBeTruthy();expect(reload).toHaveBeenCalledTimes(1);
});
test('ordinary writes reload without claiming to start project-wide curation',async()=>{
 const reload=vi.fn();render(<ToastProvider><Action send={async()=>({status:'applied'})} reload={reload}/></ToastProvider>);
 fireEvent.click(screen.getByRole('button',{name:'保存'}));await waitFor(()=>expect(reload).toHaveBeenCalledTimes(1));expect(screen.queryByText('已保存，项目重新整理已排队')).toBeNull();
});
