import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateInviteRequest,
  InviteDto,
  ListInvitesResponse,
  ListStaffResponse,
  StaffMemberDto,
  UpdateStaffRequest,
} from "@sambung/shared";
import { api } from "../../lib/api-client";

/**
 * The Team screen's server state (#57).
 *
 * Two lists, two keys, because they are two different things: an Invite is an
 * offer nobody has taken, a Staff member is an account. Every mutation touches
 * one or both, so they invalidate explicitly rather than sharing a prefix - a
 * revoke has no business refetching the roster.
 */
const STAFF_KEY = ["staff"] as const;
const INVITES_KEY = ["invites"] as const;

export function useStaff() {
  return useQuery({
    queryKey: STAFF_KEY,
    queryFn: async () => (await api.get<ListStaffResponse>("/staff")).staff,
  });
}

export function useInvites() {
  return useQuery({
    queryKey: INVITES_KEY,
    queryFn: async () =>
      (await api.get<ListInvitesResponse>("/auth/invites")).invites,
  });
}

export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInviteRequest) =>
      api.post<InviteDto>("/auth/invites", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INVITES_KEY }),
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api.delete(`/auth/invites/${inviteId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INVITES_KEY }),
  });
}

export function useUpdateStaff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateStaffRequest & { id: string }) =>
      api.patch<StaffMemberDto>(`/staff/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STAFF_KEY }),
  });
}

export function useRemoveStaff() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete(`/staff/${userId}`),
    // The roster AND everything they could see: removing a colleague does not
    // change what THIS owner sees, but leaving a stale roster on screen after a
    // destructive action is how a second click removes the wrong person.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STAFF_KEY }),
  });
}
