import { SCHEMA } from "./types";
import "./site-settings";

const queryMock = jest.fn();

describe("site_settings admin masking", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("masks secret values and sets is_set", async () => {
    queryMock.mockImplementationOnce(({ cb }) => {
      cb(undefined, {
        rows: [
          { name: "stripe_secret_key", value: "sk_test_123", readonly: false },
          { name: "help_email", value: "help@example.com", readonly: false },
          { name: "conat_password", value: "", readonly: false },
        ],
      });
    });

    const handler = SCHEMA.site_settings.user_query?.get?.instead_of_query;
    expect(typeof handler).toBe("function");

    const result: any = await new Promise((resolve, reject) => {
      handler?.(
        { _query: queryMock },
        { query: { name: null }, multi: false, options: [] },
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(rows);
        },
      );
    });

    const byName = Object.fromEntries(result.map((row) => [row.name, row]));
    expect(byName.stripe_secret_key.value).toBe("");
    expect(byName.stripe_secret_key.is_set).toBe(true);
    expect(byName.help_email.value).toBe("help@example.com");
    expect(byName.help_email.is_set).toBe(false);
    expect(byName.conat_password.value).toBe("");
    expect(byName.conat_password.is_set).toBe(false);
  });
});
