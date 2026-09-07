#ifndef EDGETERM_WASIX_RESOLV_H
#define EDGETERM_WASIX_RESOLV_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define __RES 19991006

struct __res_state
{
    int options;
};

int res_ninit(struct __res_state *state);
void res_nclose(struct __res_state *state);
int res_nquery(
    struct __res_state *state,
    const char *name,
    int dns_class,
    int type,
    unsigned char *answer,
    int answer_length
);
int dn_skipname(const unsigned char *encoded, const unsigned char *end);
int dn_expand(
    const unsigned char *message,
    const unsigned char *end,
    const unsigned char *encoded,
    char *destination,
    int destination_length
);

#ifdef __cplusplus
}
#endif

#endif
