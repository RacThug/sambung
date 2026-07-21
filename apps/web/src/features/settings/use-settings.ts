import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  TenantSettingsResponse,
  UpdateTenantSettingsRequest,
} from "@sambung/shared";
import { api } from "../../lib/api-client";

/**
 * One cache key for tenant settings (#67). Shared by the settings page and the
 * property workbench's photo gallery, which needs the cap to know when it is
 * full - so raising the cap in one tab makes the other stop saying "full" as
 * soon as the mutation writes the new value in.
 */
const SETTINGS_KEY = ["settings"] as const;

/** `GET /settings` - readable by any signed-in user (staff included). */
export function useSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api.get<TenantSettingsResponse>("/settings"),
    // Settings change about once a year. Keep them warm rather than refetching
    // on every gallery mount.
    staleTime: 5 * 60 * 1000,
  });
}

/** `PATCH /settings` - owner only; the server is the authority on that. */
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTenantSettingsRequest) =>
      api.patch<TenantSettingsResponse>("/settings", body),
    // The PATCH response IS the fresh settings - paint it, don't refetch it.
    onSuccess: (updated) => queryClient.setQueryData(SETTINGS_KEY, updated),
  });
}
