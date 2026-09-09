/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  CHAT_SPEECH_ACCENT_SETTING,
  CHAT_SPEECH_VOICE_SETTING,
  readChatSpeechPreferences,
  saveChatSpeechPreferences,
} from "./speech-preferences";

const mockValues = new Map<string, unknown>();
const mockSetOtherSettingsMany = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({
      get: () => ({ get: (key: string) => mockValues.get(key) }),
    }),
    getActions: () => ({ set_other_settings_many: mockSetOtherSettingsMany }),
  },
}));

describe("chat speech account preferences", () => {
  beforeEach(() => {
    mockValues.clear();
    mockSetOtherSettingsMany.mockReset();
  });

  it("normalizes persisted voice and accent settings", () => {
    mockValues.set(CHAT_SPEECH_VOICE_SETTING, "  Coral ");
    mockValues.set(CHAT_SPEECH_ACCENT_SETTING, "british");
    expect(readChatSpeechPreferences()).toEqual({
      voice: "coral",
      accent: "british",
    });
  });

  it("falls back safely and clears default preferences", () => {
    mockValues.set(CHAT_SPEECH_ACCENT_SETTING, "not-an-accent");
    expect(readChatSpeechPreferences()).toEqual({
      voice: undefined,
      accent: "default",
    });

    saveChatSpeechPreferences({ voice: undefined, accent: "default" });
    expect(mockSetOtherSettingsMany).toHaveBeenCalledWith({
      [CHAT_SPEECH_VOICE_SETTING]: null,
      [CHAT_SPEECH_ACCENT_SETTING]: null,
    });
  });
});
