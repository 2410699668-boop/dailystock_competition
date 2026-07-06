-- 人工恢复示例：把下面的 123 改成要恢复的 history_id。
-- 恢复也会生成一个新的 revision，不会覆盖历史记录。

update public.competition_state as current_state
set
  payload = history.payload,
  updated_by = jsonb_build_object('id', 'admin', 'name', 'Supabase后台恢复')
from public.competition_state_history as history
where current_state.id = 'main'
  and history.history_id = 123;
