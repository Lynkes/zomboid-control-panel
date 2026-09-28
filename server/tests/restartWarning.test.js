import { describe, expect, it } from "vitest";
import {
  RESTART_WARNING_PRESETS,
  defaultRestartWarningSettings,
  formatRestartWarning,
  getRestartWarningNotice,
  validateRestartWarningSettings,
} from "../utils/restartWarning.js";

describe("restart warning settings", () => {
  it("renders the Chinese preset for both minute and second countdowns", () => {
    const settings = defaultRestartWarningSettings("zh-CN");

    expect(formatRestartWarning(settings, 5, "minute")).toBe(
      "[服务器] *** 将在 5分钟 后重启 ***",
    );
    expect(formatRestartWarning(settings, 10, "second")).toBe(
      "[服务器] *** 将在 10秒 后重启 ***",
    );
    expect(getRestartWarningNotice(settings, "restarting")).toContain("正在重启");
  });

  it("renders the Brazilian Portuguese preset with singular and plural units", () => {
    const settings = defaultRestartWarningSettings("pt-BR");

    expect(settings.locale).toBe("pt-BR");
    expect(formatRestartWarning(settings, 5, "minute")).toBe(
      "[SERVIDOR] *** REINÍCIO EM 5 MINUTOS ***",
    );
    expect(formatRestartWarning(settings, 1, "minute")).toBe(
      "[SERVIDOR] *** REINÍCIO EM 1 MINUTO ***",
    );
    expect(formatRestartWarning(settings, 30, "second")).toBe(
      "[SERVIDOR] *** REINÍCIO EM 30 SEGUNDOS ***",
    );
    expect(getRestartWarningNotice(settings, "cancelled")).toBe("[SERVIDOR] Reinício CANCELADO.");
    expect(getRestartWarningNotice(settings, "restarting")).toContain("REINICIANDO AGORA");
  });

  // A preset is what "Use language preset" puts in the template box, and
  // saving it goes through the same validation as a hand-typed template --
  // an accented capital or a stray symbol in a new language's preset must
  // not make that language unsaveable.
  it("accepts every language preset's own template when it is saved", () => {
    for (const [locale, preset] of Object.entries(RESTART_WARNING_PRESETS)) {
      expect(validateRestartWarningSettings({ locale, template: preset.template })).toEqual({
        locale,
        template: preset.template,
      });
    }
  });

  it("renders a validated custom template with the selected locale's units", () => {
    const settings = validateRestartWarningSettings({
      locale: "zh-CN",
      template: "请在 {count}{unit} 内到安全地点",
    });

    expect(formatRestartWarning(settings, 1, "minute")).toBe("请在 1分钟 内到安全地点");
  });

  it("rejects unsafe command delimiters, controls, and unsupported placeholders", () => {
    for (const template of [
      'Restart in {count} {unit} "quit',
      "Restart in {count} {unit}\nquit",
      "Restart in {minutes}",
      "Restart ⚠ {count} {unit}",
    ]) {
      expect(() =>
        validateRestartWarningSettings({ locale: "en", template }),
      ).toThrow();
    }
  });
});