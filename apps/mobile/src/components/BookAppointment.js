// "Book an appointment" for yourself — opens the practice's public Dentally
// booking page. Deliberately outside the referral flow: personal bookings are
// invisible to referral tracking (a booked referral only ever updates for its
// own appointment), so nothing here counts toward anyone's referral.
import { useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { api } from '../api/client';
import { Body, GoldButton, Hairline } from './ui';
import { colors, space } from '../theme';

export default function BookAppointment({ label = 'Book an appointment', style }) {
  const [open, setOpen] = useState(false);
  const [practices, setPractices] = useState(null);

  useEffect(() => {
    if (!open || practices) return;
    api
      .practices()
      .then((out) => setPractices((out.practices ?? []).filter((p) => p.bookingUrl)))
      .catch(() => setPractices([]));
  }, [open, practices]);

  return (
    <View style={style}>
      <GoldButton variant="ghost" label={open ? 'Hide practices' : label} onPress={() => setOpen((v) => !v)} />
      {open ? (
        practices == null ? (
          <Body muted style={{ textAlign: 'center', marginTop: space(3), fontSize: 13 }}>
            Loading practices…
          </Body>
        ) : practices.length === 0 ? (
          <Body muted style={{ textAlign: 'center', marginTop: space(3), fontSize: 13 }}>
            Online booking isn’t available right now — give the practice a call.
          </Body>
        ) : (
          <View style={{ marginTop: space(3) }}>
            {practices.map((p, i) => (
              <View key={p.id}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => Linking.openURL(p.bookingUrl).catch(() => {})}
                  style={({ pressed }) => [
                    { flexDirection: 'row', alignItems: 'center', paddingVertical: space(3) },
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Body style={{ flex: 1 }}>{p.name}</Body>
                  <Text style={{ color: colors.gold, fontSize: 15 }}>Book ›</Text>
                </Pressable>
                {i < practices.length - 1 ? <Hairline /> : null}
              </View>
            ))}
            <Body muted style={{ marginTop: space(2), fontSize: 12 }}>
              Opens the practice’s booking page — separate from your referral.
            </Body>
          </View>
        )
      ) : null}
    </View>
  );
}
