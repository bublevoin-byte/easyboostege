/*
 * Экран «Профиль» (scr11). Приезжает динамическим import() при первом переходе на него.
 * Подписку, согласия и ключи дописывают хуки профиля: их регистрируют оболочка и privacy.js,
 * поэтому чанк только рисует шапку и зовёт хуки.
 */
import {registerRouteHook} from '../router.js';
import {currentUser,profileModule,runProfileHooks,setTxt} from '../app.js';

function renderProfile(){const u=profileModule.displayName(currentUser);setTxt('pf_ava',profileModule.initial(u));setTxt('pf_name',u);setTxt('pf_ai','через сервер ✓');runProfileHooks()}

registerRouteHook(function(id){if(id==='scr11')renderProfile()});

export {renderProfile};
