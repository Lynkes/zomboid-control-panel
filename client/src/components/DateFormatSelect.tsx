import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DATE_FORMAT_PREFS, setDateFormatPref, useDateFormat, type DateFormatPref } from '@/lib/dateFormat'

// Settings > General > Appearance: the order every date in the panel is
// shown in, for this browser. Each option shows the same sample date in its
// own order, 31 December so day and month can't be mistaken for each other,
// and Automatic's shows what this browser's language and region give.
export function DateFormatSelect({ id }: { id?: string }) {
  const { t } = useTranslation('settings')
  const { pref, formatDate } = useDateFormat()
  const sample = new Date(new Date().getFullYear(), 11, 31)
  // On a phone the row stacks and the label may need a second line rather
  // than losing the sample date off its end.
  return (
    <Select value={pref} onValueChange={(value) => setDateFormatPref(value as DateFormatPref)}>
      <SelectTrigger
        id={id}
        className="h-auto min-h-11 w-full shrink-0 whitespace-normal text-start sm:h-auto sm:min-h-9 sm:w-[240px] [&>span]:line-clamp-2"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {DATE_FORMAT_PREFS.map((option) => (
          <SelectItem key={option} value={option}>
            {t(`dateFormatSelect.${option}`, { example: formatDate(sample, { pref: option }) })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
