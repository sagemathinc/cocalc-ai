export interface Profile {
  account_id: string;
  display_name: string;
  first_name: string;
  last_name: string;
  color?: string;
  image?: string;
  is_admin?: boolean;
  is_partner?: boolean;
  email_address?: string;
}
