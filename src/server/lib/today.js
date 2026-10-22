/**
 * Today's date as YYYY-MM-DD on this PC's clock.
 *
 * toISOString() gives the UTC date, which in India is still yesterday until 5:30 am
 * — enough to move an order between "due now" and "overdue" overnight.
 */
export function localToday(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
