import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async () => {
  return new Response(JSON.stringify({ ok: true, function: "bootstrap-identity" }), {
    headers: { "content-type": "application/json" },
  });
});

