// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
  room_id?: string | null;
}

// --- Room types ---

export interface Room {
  room_id: string;
  name: string;
  created_at: string; // ISO timestamp
}

export interface RoomMember {
  room_id: string;
  peer_id: PeerId;
  joined_at: string; // ISO timestamp
}

export interface CreateRoomRequest {
  name: string;
}

export interface CreateRoomResponse {
  room_id: string;
  name: string;
}

export interface JoinRoomRequest {
  room_id: string;
  peer_id: PeerId;
}

export interface LeaveRoomRequest {
  room_id: string;
  peer_id: PeerId;
}

export interface PostRoomRequest {
  room_id: string;
  from_id: PeerId;
  message: string;
}

export interface ListRoomsResponse {
  rooms: Room[];
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}
