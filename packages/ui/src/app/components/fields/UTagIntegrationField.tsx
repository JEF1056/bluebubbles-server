import React, { useEffect, useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Checkbox,
    Collapse,
    FormControl,
    FormHelperText,
    HStack,
    IconButton,
    Input,
    Stack,
    Text,
    useBoolean
} from '@chakra-ui/react';
import { ipcRenderer } from 'electron';
import { AiFillEye, AiFillEyeInvisible } from 'react-icons/ai';
import { useAppSelector } from '../../hooks';
import { onCheckboxToggle } from '../../actions/ConfigActions';
import {
    UTagStatus,
    completeUtagAuth,
    disconnectUtag,
    getUtagStatus,
    setUtagPin,
    startUtagAuth,
    syncUtagNow
} from '../../utils/IpcUtils';
import { showErrorToast, showSuccessToast } from '../../utils/ToastUtils';

export const UTagIntegrationField = (): JSX.Element => {
    const enabled: boolean = Boolean(useAppSelector(state => state.config.enable_utag) ?? false);
    const [status, setStatus] = useState<UTagStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [showPaste, setShowPaste] = useBoolean(false);
    const [callbackUrl, setCallbackUrl] = useState('');
    const [pinInput, setPinInput] = useState('');
    const [showPin, setShowPin] = useBoolean(false);

    const loadStatus = async () => {
        try {
            const next = await getUtagStatus();
            setStatus(next);
        } catch {
            // Ignore initial load error if service is not ready
        }
    };

    useEffect(() => {
        loadStatus();
        const handler = (_: unknown, next: UTagStatus) => setStatus(next);
        ipcRenderer.on('utag-status-update', handler);
        return () => {
            ipcRenderer.removeListener('utag-status-update', handler);
        };
    }, []);

    const handleSignIn = async () => {
        setBusy(true);
        try {
            const res = await startUtagAuth();
            if (!res?.ok) {
                showErrorToast({
                    id: 'utag',
                    description: res?.error ?? 'Failed to open Samsung SmartThings Find sign-in.'
                });
            }
        } catch (ex: any) {
            showErrorToast({ id: 'utag', description: ex?.message ?? String(ex) });
        } finally {
            setBusy(false);
        }
    };

    const handlePasteSubmit = async () => {
        const trimmed = callbackUrl.trim();
        if (!trimmed.startsWith('ms-app://')) {
            showErrorToast({ id: 'utag', description: 'Paste the full ms-app:// redirect URL.' });
            return;
        }
        setBusy(true);
        try {
            const next = await completeUtagAuth(trimmed);
            setStatus(next);
            setCallbackUrl('');
            setShowPaste.off();
            showSuccessToast({ id: 'utag', description: 'Samsung SmartThings Find connected.' });
        } catch (ex: any) {
            showErrorToast({ id: 'utag', description: ex?.message ?? String(ex) });
        } finally {
            setBusy(false);
        }
    };

    const handleSavePin = async () => {
        const trimmed = pinInput.trim();
        if (trimmed.length > 0 && !/^\d{6}$/.test(trimmed)) {
            showErrorToast({ id: 'utag', description: 'Samsung SmartThings Find E2EE PIN must be 6 digits.' });
            return;
        }
        setBusy(true);
        try {
            const next = await setUtagPin(trimmed.length > 0 ? trimmed : null);
            setStatus(next);
            setPinInput('');
            showSuccessToast({
                id: 'utag',
                description: trimmed.length > 0 ? 'SmartTag E2EE PIN saved.' : 'SmartTag E2EE PIN cleared.'
            });
        } catch (ex: any) {
            showErrorToast({ id: 'utag', description: ex?.message ?? String(ex) });
        } finally {
            setBusy(false);
        }
    };

    const handleSyncNow = async () => {
        setBusy(true);
        try {
            const next = await syncUtagNow();
            setStatus(next);
            showSuccessToast({ id: 'utag', description: 'Samsung SmartTags synced.' });
        } catch (ex: any) {
            showErrorToast({ id: 'utag', description: ex?.message ?? String(ex) });
        } finally {
            setBusy(false);
        }
    };

    const handleDisconnect = async () => {
        setBusy(true);
        try {
            const next = await disconnectUtag();
            setStatus(next);
            setPinInput('');
            showSuccessToast({ id: 'utag', description: 'Disconnected from Samsung SmartThings Find.' });
        } catch (ex: any) {
            showErrorToast({ id: 'utag', description: ex?.message ?? String(ex) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <FormControl>
            <Checkbox id='enable_utag' isChecked={enabled} onChange={onCheckboxToggle}>
                Enable Samsung SmartThings Find (Galaxy SmartTags)
            </Checkbox>
            <FormHelperText>
                <Text>
                    Merges Samsung Galaxy SmartTags into Find My Items with cloud locations, remote ring, and Android BLE Find Nearby / UWB handoff.
                </Text>
            </FormHelperText>

            {enabled && (
                <Box mt={3} p={3} borderWidth='1px' borderRadius='md'>
                    <Stack spacing={3}>
                        <HStack spacing={2} flexWrap='wrap'>
                            <Badge colorScheme={status?.signedIn ? 'green' : 'gray'}>
                                {status?.signedIn ? 'Connected' : 'Not Signed In'}
                            </Badge>
                            {status?.signedIn && status.email && <Text fontSize='sm'>{status.email}</Text>}
                            {status?.signedIn && (
                                <Text fontSize='sm' color='gray.500'>
                                    {status.tagCount} tag(s)
                                    {status.lastSync ? ` · Last sync ${new Date(status.lastSync).toLocaleTimeString()}` : ''}
                                </Text>
                            )}
                            {status?.hasPin && <Badge colorScheme='blue'>PIN Saved</Badge>}
                        </HStack>

                        {status?.lastError && (
                            <Text fontSize='xs' color='red.400'>
                                {status.lastError}
                            </Text>
                        )}

                        <HStack spacing={2} flexWrap='wrap'>
                            <Button size='sm' colorScheme='blue' isLoading={busy} onClick={handleSignIn}>
                                {status?.signedIn ? 'Re-authenticate Samsung SmartThings Find' : 'Sign in to Samsung SmartThings Find'}
                            </Button>
                            <Button size='sm' variant='outline' onClick={setShowPaste.toggle}>
                                {showPaste ? 'Hide ms-app:// Paste' : 'Paste ms-app:// URL'}
                            </Button>
                            {status?.signedIn && (
                                <>
                                    <Button size='sm' variant='outline' isLoading={busy} onClick={handleSyncNow}>
                                        Sync Now
                                    </Button>
                                    <Button size='sm' colorScheme='red' variant='ghost' isLoading={busy} onClick={handleDisconnect}>
                                        Disconnect
                                    </Button>
                                </>
                            )}
                        </HStack>

                        <Collapse in={showPaste} animateOpacity>
                            <HStack spacing={2}>
                                <Input
                                    size='sm'
                                    placeholder='ms-app://s-1-15-2-... (from browser redirect)'
                                    value={callbackUrl}
                                    onChange={(e) => setCallbackUrl(e.target.value)}
                                />
                                <Button size='sm' isLoading={busy} onClick={handlePasteSubmit}>
                                    Complete
                                </Button>
                            </HStack>
                        </Collapse>

                        {status?.signedIn && (
                            <HStack spacing={2}>
                                <Input
                                    size='sm'
                                    maxWidth='14em'
                                    maxLength={6}
                                    type={showPin ? 'text' : 'password'}
                                    placeholder={status.hasPin ? 'Update 6-digit E2EE PIN' : 'Optional 6-digit E2EE PIN'}
                                    value={pinInput}
                                    onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                />
                                <IconButton
                                    size='sm'
                                    aria-label='Toggle PIN visibility'
                                    icon={showPin ? <AiFillEye /> : <AiFillEyeInvisible />}
                                    onClick={setShowPin.toggle}
                                />
                                <Button size='sm' isLoading={busy} onClick={handleSavePin}>
                                    {pinInput.trim().length > 0 ? 'Save PIN' : status.hasPin ? 'Clear PIN' : 'Save PIN'}
                                </Button>
                            </HStack>
                        )}
                    </Stack>
                </Box>
            )}
        </FormControl>
    );
};
