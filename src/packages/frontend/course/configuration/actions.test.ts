/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ConfigurationActions } from "./actions";

function createConfigurationActions() {
  const set = jest.fn();
  const configureAllProjects = jest.fn(async () => undefined);
  const actions = new ConfigurationActions({
    set,
    student_projects: { configure_all_projects: configureAllProjects },
  } as any);
  return { actions, configureAllProjects, set };
}

describe("course configuration payment actions", () => {
  it("stores the compute budget opt-in", () => {
    const { actions, set } = createConfigurationActions();

    actions.set_compute_budget_enabled(true);

    expect(set).toHaveBeenCalledWith(
      {
        compute_budget_enabled: true,
        table: "settings",
      },
      true,
    );
  });

  it("sets mutually exclusive direct student pay", () => {
    const { actions, set } = createConfigurationActions();

    actions.set_pay_choice("student", true);

    expect(set).toHaveBeenCalledWith(
      {
        student_pay: true,
        institute_pay: false,
        site_license_pay: false,
        table: "settings",
      },
      true,
    );
  });

  it("sets mutually exclusive institute pay", () => {
    const { actions, set } = createConfigurationActions();

    actions.set_pay_choice("institute", true);

    expect(set).toHaveBeenCalledWith(
      {
        student_pay: false,
        institute_pay: true,
        site_license_pay: false,
        table: "settings",
      },
      true,
    );
  });

  it("sets mutually exclusive site-license pay", () => {
    const { actions, set } = createConfigurationActions();

    actions.set_pay_choice("site_license", true);

    expect(set).toHaveBeenCalledWith(
      {
        student_pay: false,
        institute_pay: false,
        site_license_pay: true,
        table: "settings",
      },
      true,
    );
  });

  it("clears only the selected payment mode when disabled", () => {
    const { actions, set } = createConfigurationActions();

    actions.set_pay_choice("student", false);
    actions.set_pay_choice("institute", false);
    actions.set_pay_choice("site_license", false);

    expect(set).toHaveBeenNthCalledWith(
      1,
      {
        student_pay: false,
        table: "settings",
      },
      true,
    );
    expect(set).toHaveBeenNthCalledWith(
      2,
      {
        institute_pay: false,
        table: "settings",
      },
      true,
    );
    expect(set).toHaveBeenNthCalledWith(
      3,
      {
        site_license_pay: false,
        table: "settings",
      },
      true,
    );
  });
});

describe("course invitation identity policy", () => {
  it("publishes the setting before reconfiguring managed projects", async () => {
    const { actions, configureAllProjects, set } = createConfigurationActions();

    await actions.set_require_invite_email_match(true);

    expect(set).toHaveBeenCalledWith(
      {
        require_invite_email_match: true,
        table: "settings",
      },
      true,
      true,
    );
    expect(configureAllProjects).toHaveBeenCalledTimes(1);
    expect(set.mock.invocationCallOrder[0]).toBeLessThan(
      configureAllProjects.mock.invocationCallOrder[0],
    );
  });
});
