// Команды персонажу из любого места приложения (без зависимости от React).
//
// Правило: пока пользователь работает, персонаж неподвижен. Сам он играет только в простое
// (сценки ниже) и сразу сворачивает их при любом движении мыши, клавише, клике или прокрутке.
// Команды goto/say/wave/home нужны для осознанных событий приложения (например, «пришло решение»).
//
// Якорь — любой элемент с атрибутом data-avatar-anchor="<id>".
// spread: персонаж «растекается» по элементу полупрозрачной подсветкой (клики не перехватывает).
// Исключить область из его маршрутов: data-avatar-ignore; обязательно обходить: data-avatar-avoid.

export const SCENE_IDS = [
  "party", // привёл друзей, мини-тусовка
  "sleep", // уснул
  "study", // изучает материал на странице
  "code", // программирует на ноутбуке
  "coffee", // кофе-пауза
  "juggle", // жонглирует шариками
  "workout", // зарядка с гантелями
  "butterfly", // гоняется за бабочкой
  "magic", // фокус: кролик из шляпы
] as const;
export type SceneId = (typeof SCENE_IDS)[number];

export type AvatarCommand =
  | { type: "goto"; anchor: string; say?: string; spread?: boolean }
  | { type: "say"; text: string }
  | { type: "wave" }
  | { type: "home" }
  | { type: "enable"; on: boolean }
  | { type: "play"; scene: SceneId };

export const AVATAR_EVENT = "avatar:command";

export function avatarCommand(detail: AvatarCommand): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AvatarCommand>(AVATAR_EVENT, { detail }));
}
