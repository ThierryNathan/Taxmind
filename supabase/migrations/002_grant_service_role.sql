-- Garante acesso do service_role às tabelas operacionais
-- Necessário para Edge Functions que rodam com esse role
GRANT SELECT, INSERT, UPDATE ON public.sessoes_whatsapp TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.recibos_evidencias TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.usuarios TO service_role;